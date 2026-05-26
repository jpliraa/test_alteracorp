import { Tracer } from '@aws-lambda-powertools/tracer';
import { loadEnv } from './env';

const env = loadEnv();

/**
 * Singleton Tracer (X-Ray) compartido por handlers y services.
 *
 * Pattern de uso:
 *
 * 1) Auto-instrumentación de clientes AWS SDK v3 (lo más útil):
 *    ```ts
 *    const baseClient = new DynamoDBClient({...});
 *    const tracedClient = tracer.captureAWSv3Client(baseClient);
 *    ```
 *    → cada llamada al SDK genera un subsegment X-Ray con timing y errores.
 *
 * 2) Subsegments custom para lógica de negocio:
 *    ```ts
 *    await withSubsegment('putIdempotencyKey', async (sub) => {
 *      sub?.addAnnotation('idempotencyKey', key);
 *      await ddb.send(...);
 *    });
 *    ```
 */
export const tracer = new Tracer({
  serviceName: env.serviceName,
});

/**
 * Helper para envolver una operación async en un subsegment custom de X-Ray.
 *
 * - Si X-Ray no está activo (ej. corriendo `jest` fuera de Lambda), `getSegment()`
 *   devuelve undefined y la función simplemente ejecuta `fn` sin tracing.
 * - Si la operación tira, marca el subsegment como error antes de re-lanzar.
 * - Siempre cierra el subsegment en el `finally` para que el segmento padre no
 *   quede "abierto" en X-Ray.
 *
 * @param name nombre del subsegment (aparece en X-Ray como nodo)
 * @param fn   función async que recibe el subsegment para anotaciones
 */
export async function withSubsegment<T>(
  name: string,
  fn: (subsegment: ReturnType<NonNullable<ReturnType<typeof tracer.getSegment>>['addNewSubsegment']> | undefined) => Promise<T>,
): Promise<T> {
  const parent = tracer.getSegment();
  const subsegment = parent?.addNewSubsegment(name);

  try {
    return await fn(subsegment);
  } catch (err) {
    if (subsegment && err instanceof Error) {
      subsegment.addError(err);
    }
    throw err;
  } finally {
    subsegment?.close();
  }
}
