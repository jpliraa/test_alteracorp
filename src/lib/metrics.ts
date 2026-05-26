import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { loadEnv } from './env';

const env = loadEnv();

/**
 * Singleton Metrics (CloudWatch EMF) compartido por handlers.
 *
 * Powertools Metrics emite logs en formato EMF (Embedded Metric Format):
 * CloudWatch los detecta y los convierte en custom metrics SIN llamadas API
 * extra (vs PutMetricData), ahorrando latencia y costo.
 *
 * Dimensiones por defecto (`addDimension`) se agregan a TODA métrica:
 *   - Pasarela=PAYHUB → especificado en el enunciado.
 *   - Stage=dev/staging/prod → para separar dashboards por ambiente.
 *
 * Métricas que emitiremos (Tarea 5 / Fase 5):
 *   - PagosProcesados   (Count)        : pagos persistidos en `pagos`.
 *   - PagosFallidos     (Count)        : pagos que fueron a batchItemFailures.
 *   - LatenciaProcesado (Milliseconds) : tiempo end-to-end por mensaje.
 *
 * Llamar `metrics.publishStoredMetrics()` al final del handler para flushear
 * (o usar `@logMetrics` decorator si activamos middy).
 */
export const metrics = new Metrics({
  namespace: env.metricsNamespace,
  serviceName: env.serviceName,
  defaultDimensions: {
    Pasarela: 'PAYHUB',
    Stage: env.stage,
  },
});

// Re-exportamos MetricUnit para que los call sites no importen Powertools directo.
export { MetricUnit };
