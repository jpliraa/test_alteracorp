import { Logger } from '@aws-lambda-powertools/logger';
import { loadEnv } from './env';

/**
 * Singleton Logger compartido por handlers y services.
 *
 * Pattern de uso en un handler:
 *
 * ```ts
 * export const handler = async (event, context) => {
 *   logger.addContext(context);                          // awsRequestId, fn name, etc.
 *   logger.appendKeys({ correlationId });                // mismo ID en todos los logs
 *   logger.info('Webhook recibido', { transaccionId });  // log estructurado
 * };
 * ```
 *
 * Lambda reutiliza el container entre invocaciones, por lo que el Logger es
 * estado compartido. `addContext`/`appendKeys` sobrescriben en cada invocación,
 * así que en la práctica los keys de la invocación previa quedan reemplazados.
 * El único riesgo sería loguear desde un callback que sobrevive al handler;
 * en este código no tenemos ese patrón.
 *
 * Nivel de log se configura via `POWERTOOLS_LOG_LEVEL` (env var):
 *   - dev:     DEBUG (todo)
 *   - staging: INFO  (sin debug ruidoso)
 *   - prod:    WARN  (solo warn/error)
 *   - tests:   SILENT (output limpio en CI)
 */
const env = loadEnv();

export const logger = new Logger({
  serviceName: env.serviceName,
  // logLevel viene de POWERTOOLS_LOG_LEVEL automáticamente.
  // En tests/setup.ts se fuerza a SILENT.
});
