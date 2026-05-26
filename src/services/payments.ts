import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { loadEnv } from '../lib/env';
import { withSubsegment } from '../lib/tracer';
import { ddb } from './idempotency';
import type { WebhookMessage } from './schemas';

const env = loadEnv();

/**
 * Reutilizamos el `DynamoDBDocumentClient` exportado desde `idempotency.ts`
 * (ya trazado por X-Ray vía `captureAWSv3Client`).
 *
 * Una sola instancia compartida por proceso Lambda = menos cold start +
 * mantenimiento de pool de conexiones HTTP reutilizado.
 */

/**
 * Item que se persiste en la tabla `pagos`. Mirror del Zod schema más metadatos.
 *
 * PK: transaccionId
 * SK: timestamp (ISO 8601 del evento — viene de PayHub, NO de nosotros)
 *
 * `idempotencyKey` se persiste para trazabilidad cruzada con la tabla
 * `idempotency_keys` (poder ir y volver entre ambas en investigaciones).
 *
 * `processedAt` (nuestro `now`) es distinto de `timestamp` (cuando PayHub
 * generó el evento) y de `ingestionTimestamp` (cuando lo recibió el Receiver).
 * Triple registro temporal permite calcular SLOs end-to-end.
 */
export interface PagoItem {
  transaccionId: string;
  timestamp: string;        // SK; viene del payload (cuándo PayHub generó el evento)
  referencia: string;
  clienteRut: string;
  monto: number;
  estado: string;           // 'procesado' por defecto al persistir
  idempotencyKey: string;   // cross-table tracing
  processedAt: string;      // cuándo persistimos (ISO 8601)
  ingestionTimestamp: string; // cuándo el Receiver aceptó el webhook
}

/**
 * Persiste un pago en la tabla `pagos` con `ConditionExpression` defensiva.
 *
 * **Defense in depth** (rúbrica Idempotencia 15%):
 *  - La tabla `idempotency_keys` ya garantiza que el Receiver no encole 2 veces
 *    el mismo evento.
 *  - PERO: un mensaje SQS puede entregarse al Processor más de una vez
 *    (SQS at-least-once: visibility timeout, redrive, etc.).
 *  - Por eso ACÁ TAMBIÉN ponemos `ConditionExpression: attribute_not_exists(transaccionId)`.
 *  - Si la condición falla → ya está persistido → tratamos como éxito SILENCIOSO
 *    (no es un error; el trabajo ya está hecho). El handler debe detectar
 *    `ConditionalCheckFailedException` y NO meter el record en `batchItemFailures`.
 *
 * **Por qué `attribute_not_exists(transaccionId)`** (y no `(timestamp)`):
 *  - DDB evalúa la condición contra el item con el PK+SK COMPLETO del PutItem.
 *  - `attribute_not_exists(transaccionId)` se traduce a "no existe NINGÚN item con
 *    este PK+SK". Es la forma canónica de "insert only if not exists" en DDB.
 *
 * Wrappeado en subsegment X-Ray `persistPago` para visibilidad agrupada.
 */
export async function persistPago(message: WebhookMessage): Promise<void> {
  await withSubsegment('persistPago', async (sub) => {
    sub?.addAnnotation('transaccionId', message.payload.transaccionId);
    sub?.addAnnotation('idempotencyKey', message.idempotencyKey);

    const item: PagoItem = {
      transaccionId: message.payload.transaccionId,
      timestamp: message.payload.timestamp,
      referencia: message.payload.referencia,
      clienteRut: message.payload.clienteRut,
      monto: message.payload.monto,
      estado: 'procesado',
      idempotencyKey: message.idempotencyKey,
      processedAt: new Date().toISOString(),
      ingestionTimestamp: message.ingestionTimestamp,
    };

    await ddb.send(
      new PutCommand({
        TableName: env.pagosTable,
        Item: item,
        ConditionExpression: 'attribute_not_exists(transaccionId)',
      }),
    );
  });
}
