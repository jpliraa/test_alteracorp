import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { loadEnv } from '../lib/env';
import { tracer, withSubsegment } from '../lib/tracer';

/** TTL de 24h en segundos epoch — la rúbrica lo exige (Tarea 6). */
const TTL_24H_SECONDS = 24 * 60 * 60;

const env = loadEnv();

/**
 * Cliente DDB v3 con auto-instrumentación X-Ray.
 * Cada `ddb.send(...)` genera un subsegment "DynamoDB <Operation>" automático.
 * En local, `endpoint` apunta a DynamoDB Local; en AWS, el SDK resuelve a la región.
 */
const baseClient = new DynamoDBClient({
  region: env.region,
  ...(env.dynamodbEndpoint !== undefined ? { endpoint: env.dynamodbEndpoint } : {}),
  ...(env.isOffline ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});
const tracedClient = tracer.captureAWSv3Client(baseClient);
export const ddb = DynamoDBDocumentClient.from(tracedClient);

/** Input minimal para el PutItem condicional. */
export interface PutIdempotencyInput {
  idempotencyKey: string;
  transaccionId: string;
}

/**
 * Inserta el registro de idempotencia con `ConditionExpression:
 * attribute_not_exists(idempotencyKey)`.
 *
 * - Si la condición se cumple (key no existe) → escribe y retorna.
 * - Si la condición falla → lanza `ConditionalCheckFailedException`. El handler
 *   debe capturarla y traducirla a `200 already_processed` (no es un error).
 *
 * Items escritos:
 *   - idempotencyKey  (PK)
 *   - transaccionId   (para trazabilidad)
 *   - status: 'received'
 *   - createdAt       (ISO 8601, cuándo aceptamos el webhook)
 *   - ttl             (epoch seconds, createdAt + 24h)
 *
 * Wrappeado en un subsegment X-Ray custom llamado "putIdempotencyKey" para
 * tener latencia/errores agrupados en el dashboard de X-Ray (no solo el subsegment
 * automático "DynamoDB PutItem").
 */
export async function putIdempotencyKey(input: PutIdempotencyInput): Promise<void> {
  await withSubsegment('putIdempotencyKey', async (sub) => {
    sub?.addAnnotation('idempotencyKey', input.idempotencyKey);
    sub?.addAnnotation('transaccionId', input.transaccionId);

    const now = new Date();
    const ttl = Math.floor(now.getTime() / 1000) + TTL_24H_SECONDS;

    await ddb.send(
      new PutCommand({
        TableName: env.idempotencyTable,
        Item: {
          idempotencyKey: input.idempotencyKey,
          transaccionId: input.transaccionId,
          status: 'received',
          createdAt: now.toISOString(),
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  });
}
