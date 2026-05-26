import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

import { loadEnv } from '../lib/env';
import { logger } from '../lib/logger';
import { verifySignature } from '../lib/hmac';
import { putIdempotencyKey } from '../services/idempotency';
import { enqueueWebhook } from '../services/queue';
import { webhookBodySchema } from '../services/schemas';

const env = loadEnv();

// Header names — comparamos lower-case porque API Gateway HTTP API v2 normaliza
// los headers entrantes a lower-case (a diferencia de REST API v1).
const SIG_HEADER = 'x-payhub-signature';
const KEY_HEADER = 'x-payhub-idempotency-key';
const ORIGIN_HEADER = 'x-payhub-origin';

// -----------------------------------------------------------------------------
// Helpers locales
// -----------------------------------------------------------------------------

/** Construye una respuesta JSON estándar. Siempre con content-type explícito. */
function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Lee un header del event de forma defensiva (puede ser undefined). */
function getHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
  return event.headers?.[name];
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

/**
 * Receiver Lambda — webhook PayHub.
 *
 * Flujo (Tarea 4 del enunciado):
 *
 *   1. Verificar firma HMAC (X-PayHub-Signature)             → 401 si falla.
 *   2. Validar presencia de headers obligatorios             → 400 si falta alguno.
 *   3. Parsear body con Zod                                  → 400 si falla.
 *   4. PutItem condicional en `idempotency_keys`             → 200 already_processed
 *                                                              si ConditionalCheckFailed.
 *   5. SendMessage a SQS con el evento + correlationId.
 *   6. Responder 202 accepted con { status, idempotencyKey }.
 *
 *   Cualquier error inesperado → 500 con body genérico (NUNCA exponer stack).
 *
 * Correlation ID:
 *   - Si el request trae `X-PayHub-Idempotency-Key`, usamos ese como correlationId.
 *   - Si no, usamos `context.awsRequestId` como fallback (raro, porque el flujo
 *     normal exige el header — pero el flujo de error de "header faltante" igual
 *     necesita correlation para troubleshooting).
 *   - El correlationId se propaga al body del mensaje SQS → el Processor lo
 *     setea en su Logger → todos los logs del flujo comparten ID.
 */
export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  // Adjuntamos contexto de AWS (awsRequestId, function name, etc.) a TODOS los logs.
  logger.addContext(context);

  // Correlation ID: header preferred, fallback al request ID de Lambda.
  const idempotencyKey = getHeader(event, KEY_HEADER);
  const correlationId = idempotencyKey ?? context.awsRequestId;
  logger.appendKeys({ correlationId });

  try {
    // -------------------------------------------------------------------------
    // Step 1 — Verificar HMAC
    // -------------------------------------------------------------------------
    // El body se valida en sus bytes crudos (no parsear antes — cambiaría la
    // firma). API Gateway HTTP API v2 entrega event.body como string para
    // content-type JSON, sin base64.
    const rawBody = event.body ?? '';
    const signature = getHeader(event, SIG_HEADER) ?? '';

    if (!verifySignature(rawBody, signature, env.payhubHmacSecret)) {
      logger.warn('HMAC inválido; rechazando webhook con 401');
      return jsonResponse(401, { status: 'unauthorized' });
    }

    // -------------------------------------------------------------------------
    // Step 2 — Validar headers obligatorios
    // -------------------------------------------------------------------------
    // HMAC válido garantiza autenticidad. Ahora verificamos que vinieron los
    // metadatos necesarios para idempotencia y trazabilidad.
    const origin = getHeader(event, ORIGIN_HEADER);
    if (!idempotencyKey || !origin) {
      logger.warn('Headers obligatorios faltantes', {
        hasIdempotencyKey: Boolean(idempotencyKey),
        hasOrigin: Boolean(origin),
      });
      return jsonResponse(400, { status: 'bad_request' });
    }

    // -------------------------------------------------------------------------
    // Step 3 — Parsear body con Zod
    // -------------------------------------------------------------------------
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      logger.warn('Body no es JSON válido');
      return jsonResponse(400, { status: 'bad_request' });
    }

    const validation = webhookBodySchema.safeParse(parsedJson);
    if (!validation.success) {
      logger.warn('Body no cumple el contrato del webhook', {
        // Issues SIN incluir el `received` (puede contener datos sensibles del cliente).
        issues: validation.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
      });
      return jsonResponse(400, { status: 'bad_request' });
    }
    const payload = validation.data;

    // Enriquecemos el contexto del Logger con info de negocio (no PII sensible).
    logger.appendKeys({ transaccionId: payload.transaccionId });

    // -------------------------------------------------------------------------
    // Step 4 — PutItem condicional en idempotency_keys
    // -------------------------------------------------------------------------
    // ConditionExpression evita la race condition de "check-then-write": dos
    // requests con el mismo idempotencyKey en paralelo, solo uno gana el PUT.
    try {
      await putIdempotencyKey({
        idempotencyKey,
        transaccionId: payload.transaccionId,
      });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Duplicado: PayHub está reintentando un evento que ya aceptamos.
        // NO encolamos de nuevo. Respondemos 200 (no 4xx) para que PayHub deje
        // de reintentar — el evento ya está "en proceso/procesado" desde su POV.
        logger.info('Evento duplicado (idempotencyKey ya existe); skip enqueue');
        return jsonResponse(200, { status: 'already_processed', idempotencyKey });
      }
      // Otro error de DDB → bubble al outer try, responderá 500.
      throw err;
    }

    // -------------------------------------------------------------------------
    // Step 5 — Enviar a SQS
    // -------------------------------------------------------------------------
    // NOTA sobre defense in depth: si SendMessage falla acá, el item ya quedó
    // escrito en idempotency_keys → en un retry de PayHub responderíamos
    // already_processed sin haber encolado nunca. Documentado en
    // DECISIONS.md (D17) como limitación conocida. Mitigación recomendada
    // para producción: compensación con DeleteItem, o transición de estado
    // 'received' → 'enqueued' con job de cleanup para 'received' antiguos.
    await enqueueWebhook({
      idempotencyKey,
      correlationId,
      ingestionTimestamp: new Date().toISOString(),
      payload,
    });

    // -------------------------------------------------------------------------
    // Step 6 — Responder 202 accepted
    // -------------------------------------------------------------------------
    // 202 (Accepted) es semánticamente correcto: aceptamos para procesamiento
    // asíncrono, NO confirmamos que el pago ya esté persistido en `pagos`.
    logger.info('Webhook aceptado para procesamiento asíncrono');
    return jsonResponse(202, { status: 'accepted', idempotencyKey });
  } catch (err) {
    // Catch-all: cualquier error no anticipado responde 500 con body genérico.
    // - NUNCA exponer stack ni mensajes internos al externo (rúbrica seguridad).
    // - SIEMPRE loguear con error level para que aparezca en alarma "ErrorRate > 1%".
    logger.error('Error inesperado en Receiver', {
      errorName: err instanceof Error ? err.name : 'unknown',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { status: 'internal_error' });
  }
};
