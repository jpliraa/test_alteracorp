import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadEnv } from '../lib/env';
import { tracer, withSubsegment } from '../lib/tracer';
import type { WebhookMessage } from './schemas';

const env = loadEnv();

/**
 * Cliente SQS v3 auto-instrumentado para X-Ray.
 * En local, `endpoint` apunta a ElasticMQ; en AWS resuelve a la URL real.
 */
const baseClient = new SQSClient({
  region: env.region,
  ...(env.sqsEndpoint !== undefined ? { endpoint: env.sqsEndpoint } : {}),
  ...(env.isOffline ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});
export const sqs = tracer.captureAWSv3Client(baseClient);

/**
 * Envía el mensaje del webhook a la cola principal para procesamiento asíncrono.
 *
 * Decisiones:
 *  - `MessageBody`: el `WebhookMessage` serializado como JSON. El Processor lo
 *    parsea con `webhookMessageSchema`.
 *  - `MessageAttributes.correlationId`: duplicamos el correlationId en attribute
 *    para que se pueda filtrar/buscar en SQS sin parsear el body. También permite
 *    que el Processor lo extraiga sin parsear si solo necesita el ID para logging.
 *
 * Wrappeado en subsegment X-Ray "enqueueWebhook" para visibilidad agregada.
 */
export async function enqueueWebhook(message: WebhookMessage): Promise<void> {
  await withSubsegment('enqueueWebhook', async (sub) => {
    sub?.addAnnotation('idempotencyKey', message.idempotencyKey);
    sub?.addAnnotation('correlationId', message.correlationId);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: env.webhookQueueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          correlationId: {
            DataType: 'String',
            StringValue: message.correlationId,
          },
          idempotencyKey: {
            DataType: 'String',
            StringValue: message.idempotencyKey,
          },
        },
      }),
    );
  });
}
