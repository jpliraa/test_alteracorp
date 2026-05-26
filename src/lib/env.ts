import { z } from 'zod';

/**
 * Schema de variables de entorno requeridas por las Lambdas.
 *
 * Las strict (`.min(1)`) son las que sin las cuales el sistema NO debe arrancar:
 *   - PAYHUB_HMAC_SECRET → sin secret no podemos verificar firmas → todos los
 *     requests serían 401 → endpoint inservible. Falla fast en cold start.
 *   - IDEMPOTENCY_TABLE / PAGOS_TABLE → sin nombres de tabla no podemos persistir.
 *   - WEBHOOK_QUEUE_URL → sin URL no podemos encolar (Receiver) ni recibir
 *     (Processor) — aunque el event source mapping lo aporta para Processor,
 *     dejarlo requerido captura misconfig temprano.
 *
 * Las opcionales (`.optional()`) son overrides locales que solo existen en dev:
 *   - DYNAMODB_ENDPOINT → cuando está, el SDK apunta a DDB Local (:8000) en vez de AWS.
 *   - SQS_ENDPOINT      → idem para ElasticMQ (:9324).
 *
 * `IS_OFFLINE` la setea automáticamente serverless-offline cuando corre local;
 * la leemos por separado del schema porque no se setea en deploy real.
 */
const envSchema = z.object({
  STAGE: z.string().default('dev'),
  AWS_REGION: z.string().default('us-east-1'),

  PAYHUB_HMAC_SECRET: z.string().min(1, 'PAYHUB_HMAC_SECRET es requerido'),

  IDEMPOTENCY_TABLE: z.string().min(1, 'IDEMPOTENCY_TABLE es requerido'),
  PAGOS_TABLE: z.string().min(1, 'PAGOS_TABLE es requerido'),

  WEBHOOK_QUEUE_URL: z.string().min(1, 'WEBHOOK_QUEUE_URL es requerido'),
  WEBHOOK_DLQ_URL: z.string().optional(),

  // Endpoints locales: tratamos string vacío como undefined porque
  // serverless.yml los inyecta como '' en deploy real (no como ausente).
  DYNAMODB_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  SQS_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  POWERTOOLS_SERVICE_NAME: z.string().default('prueba-altera-b2'),
  POWERTOOLS_METRICS_NAMESPACE: z.string().default('PruebaAlteraB2'),
});

/** Tipo de la configuración resuelta (camelCase, normalizado). */
export interface AppEnv {
  stage: string;
  region: string;
  payhubHmacSecret: string;
  idempotencyTable: string;
  pagosTable: string;
  webhookQueueUrl: string;
  webhookDlqUrl: string | undefined;
  dynamodbEndpoint: string | undefined;
  sqsEndpoint: string | undefined;
  serviceName: string;
  metricsNamespace: string;
  isOffline: boolean;
}

/**
 * Cache singleton. Calculamos una sola vez por contenedor Lambda.
 * En tests usar `_resetEnvCache()` para forzar re-lectura.
 */
let cached: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cached !== null) return cached;

  const raw = envSchema.parse(process.env);

  cached = {
    stage: raw.STAGE,
    region: raw.AWS_REGION,
    payhubHmacSecret: raw.PAYHUB_HMAC_SECRET,
    idempotencyTable: raw.IDEMPOTENCY_TABLE,
    pagosTable: raw.PAGOS_TABLE,
    webhookQueueUrl: raw.WEBHOOK_QUEUE_URL,
    webhookDlqUrl: raw.WEBHOOK_DLQ_URL,
    dynamodbEndpoint: raw.DYNAMODB_ENDPOINT,
    sqsEndpoint: raw.SQS_ENDPOINT,
    serviceName: raw.POWERTOOLS_SERVICE_NAME,
    metricsNamespace: raw.POWERTOOLS_METRICS_NAMESPACE,
    isOffline: process.env['IS_OFFLINE'] === 'true',
  };

  return cached;
}

/** Solo para tests: limpia el cache para re-leer process.env. */
export function _resetEnvCache(): void {
  cached = null;
}
