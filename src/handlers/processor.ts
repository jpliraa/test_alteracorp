import type {
  Context,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

import { logger } from '../lib/logger';
import { metrics, MetricUnit } from '../lib/metrics';
import { persistPago } from '../services/payments';
import { normalizeWebhookMessage } from '../services/schemas';

// -----------------------------------------------------------------------------
// Simulación de fallo transient (5% por defecto, configurable en tests)
// -----------------------------------------------------------------------------

/**
 * Lee la probabilidad de fallo en cada call (NO al cargar el módulo), así
 * los tests pueden hacer `process.env.TRANSIENT_FAILURE_RATE = '1'` antes
 * de invocar el handler para forzar fallo.
 *
 * Default 0.05 (5%) — match con el enunciado.
 * Tests con `tests/setup.ts` lo dejan en 0 para que no haya flake.
 */
function getTransientFailureRate(): number {
  const raw = process.env['TRANSIENT_FAILURE_RATE'];
  if (raw === undefined) return 0.05;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0.05;
}

/**
 * Simula la llamada a un servicio externo (ej. gateway de confirmación de pago)
 * que falla con probabilidad `TRANSIENT_FAILURE_RATE`. Cuando falla:
 *   - el handler lo captura → push a `batchItemFailures`
 *   - SQS lo devuelve a la cola (visibility timeout vence)
 *   - tras 3 entregas el mensaje va a la DLQ (maxReceiveCount: 3)
 */
function simulateExternalCall(): void {
  if (Math.random() < getTransientFailureRate()) {
    throw new Error('SimulatedTransientFailure: external service timeout');
  }
}

// -----------------------------------------------------------------------------
// Procesamiento de un record individual
// -----------------------------------------------------------------------------

/**
 * Procesa un único `SQSRecord`:
 *   1. Extrae correlationId (preferente: messageAttributes; fallback: body).
 *   2. Parsea el body como JSON.
 *   3. Normaliza al `WebhookMessage` canónico (soporta shape moderno + legacy).
 *   4. Llama servicio externo simulado (5% fallo transient).
 *   5. Persiste en `pagos` con `ConditionExpression` (defense in depth).
 *      → `ConditionalCheckFailedException` se trata como éxito (ya estaba).
 *
 * Si CUALQUIER paso lanza, el handler captura, agrega a `batchItemFailures`
 * y continúa con los demás records.
 */
async function processRecord(record: SQSRecord): Promise<void> {
  // -- 1. CorrelationId ----------------------------------------------------
  // Preferimos messageAttributes (lo setea nuestro Receiver explícitamente).
  // Si el body se logró parsear, tomamos `correlationId` del WebhookMessage.
  // Fallback final: `messageId` del SQS record (siempre presente).
  const attrCorr = record.messageAttributes?.['correlationId']?.stringValue;
  let correlationId = attrCorr ?? record.messageId;
  logger.appendKeys({
    correlationId,
    sqsMessageId: record.messageId,
  });

  // -- 2. Parse JSON --------------------------------------------------------
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(record.body);
  } catch (err) {
    logger.warn('SQS body no es JSON parseable', {
      bodyExcerpt: record.body.slice(0, 60),
    });
    throw err;
  }

  // -- 3. Normalizar al WebhookMessage canónico ----------------------------
  const message = normalizeWebhookMessage(rawObj); // tira ZodError si ningún shape calza

  // Refinamos correlationId si lo tenemos en el body.
  if (message.correlationId && message.correlationId !== correlationId) {
    correlationId = message.correlationId;
    logger.appendKeys({ correlationId });
  }
  logger.appendKeys({ transaccionId: message.payload.transaccionId });

  // -- 4. Llamada externa simulada (puede fallar transient) ----------------
  simulateExternalCall();

  // -- 5. Persistir con defense in depth -----------------------------------
  try {
    await persistPago(message);
    logger.info('Pago persistido en tabla pagos');
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Ya estaba: SQS at-least-once nos volvió a entregar el mismo evento.
      // NO es un error — el trabajo ya está hecho.
      logger.info('Pago ya estaba persistido (defense in depth atrapó duplicado)');
      return;
    }
    throw err;
  }

  // -- 6. Métrica de latencia end-to-end -----------------------------------
  // ingestionTimestamp = cuando el Receiver aceptó el webhook.
  // Diferencia con `now` = SQS queue time + Processor execution time.
  // Es el indicador real de "cuánto tarda el sistema en confirmar un pago".
  const ingestionMs = Date.parse(message.ingestionTimestamp);
  if (Number.isFinite(ingestionMs)) {
    const latencyMs = Date.now() - ingestionMs;
    metrics.addMetric('LatenciaProcesado', MetricUnit.Milliseconds, latencyMs);
  }
}

// -----------------------------------------------------------------------------
// Handler — orquesta el batch y devuelve partial batch failure response
// -----------------------------------------------------------------------------

/**
 * Processor Lambda — consume webhooks confirmados desde SQS.
 *
 * Configurado en serverless.yml:
 *   - batchSize: 5
 *   - maximumBatchingWindow: 1
 *   - functionResponseType: ReportBatchItemFailures
 *
 * Comportamiento:
 *   - Procesa cada record independientemente.
 *   - Si uno falla, los demás SIGUEN procesándose.
 *   - El response es `{ batchItemFailures: [{ itemIdentifier: messageId }, ...] }`.
 *   - SQS solo devuelve a la cola los messageIds reportados; los exitosos se borran.
 *   - Tras 3 entregas fallidas (maxReceiveCount), el mensaje va a la DLQ.
 *
 * Métricas custom emitidas por record:
 *   - `PagosProcesados`   (Count, +1 por éxito o duplicado-ignorado)
 *   - `PagosFallidos`     (Count, +1 por fallo)
 *   - `LatenciaProcesado` (Milliseconds, end-to-end, solo en éxitos con timestamp parseable)
 *
 * Dimensiones de cada métrica (ver `lib/metrics.ts`): `Pasarela=PAYHUB`, `Stage`.
 *
 * NUNCA tira excepción al runtime de Lambda: hacerlo invalidaría TODO el batch.
 */
export const handler = async (
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> => {
  logger.addContext(context);
  // Limpieza preventiva de keys de invocaciones previas en el mismo container.
  logger.removeKeys(['correlationId', 'sqsMessageId', 'transaccionId']);

  const batchStart = Date.now();
  const batchItemFailures: SQSBatchItemFailure[] = [];

  logger.info('Batch recibido', { recordCount: event.Records.length });

  for (const record of event.Records) {
    // Reset por-record para que las keys de un record no leakeen al siguiente.
    logger.removeKeys(['correlationId', 'sqsMessageId', 'transaccionId']);

    try {
      await processRecord(record);
      metrics.addMetric('PagosProcesados', MetricUnit.Count, 1);
    } catch (err) {
      logger.error('Falla procesando record SQS', {
        sqsMessageId: record.messageId,
        errorName: err instanceof Error ? err.name : 'unknown',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      metrics.addMetric('PagosFallidos', MetricUnit.Count, 1);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Flush EMF metrics al stdout (CloudWatch los recoge automáticamente).
  metrics.publishStoredMetrics();

  // Limpieza final para no contaminar el siguiente cold-start si lo hubiera.
  logger.removeKeys(['correlationId', 'sqsMessageId', 'transaccionId']);

  logger.info('Batch procesado', {
    totalRecords: event.Records.length,
    successful: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
    elapsedMs: Date.now() - batchStart,
  });

  return { batchItemFailures };
};
