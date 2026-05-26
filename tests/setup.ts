/**
 * Setup global de Jest — corre ANTES de cualquier import en los tests.
 *
 * Configurado en jest.config.ts via `setupFiles`. La distinción importante:
 *   - `setupFiles`         → corre antes del framework de tests (ideal para env vars)
 *   - `setupFilesAfterEach`→ después de cada test (no lo usamos)
 *   - `setupFilesAfterEnv` → después de instalar Jest pero antes de los tests
 *
 * Las env vars setteadas acá las consume `src/lib/env.ts` cuando los módulos
 * de producción se importan en los tests.
 */

// Stage y región
process.env['STAGE'] = 'test';
process.env['AWS_REGION'] = 'us-east-1';

// Secret HMAC para tests — distinto al de dev para no confundir.
process.env['PAYHUB_HMAC_SECRET'] = 'test-secret-payhub';

// Nombres de tabla y URL de cola — valores arbitrarios, los mocks no validan.
process.env['IDEMPOTENCY_TABLE'] = 'prueba-altera-b2-idempotency-test';
process.env['PAGOS_TABLE'] = 'prueba-altera-b2-pagos-test';
process.env['WEBHOOK_QUEUE_URL'] =
  'https://sqs.us-east-1.amazonaws.com/123456789012/prueba-altera-b2-webhook-test';

// Powertools
process.env['POWERTOOLS_SERVICE_NAME'] = 'prueba-altera-b2-test';
process.env['POWERTOOLS_METRICS_NAMESPACE'] = 'PruebaAlteraB2Test';

// Silenciar logs en CI/output de tests (SILENT = nada se imprime).
process.env['POWERTOOLS_LOG_LEVEL'] = 'SILENT';

// Desactivar X-Ray en tests (no hay daemon corriendo).
process.env['POWERTOOLS_TRACE_ENABLED'] = 'false';

// Apagar la simulación de fallo transient por defecto en tests para evitar
// flakiness. Tests específicos pueden setear '1' antes de invocar el handler.
process.env['TRANSIENT_FAILURE_RATE'] = '0';

// -----------------------------------------------------------------------------
// Silenciar EMF metric output de Powertools en tests.
// Powertools Metrics escribe a console.log con formato {"_aws":...} para que
// CloudWatch lo ingiera. En tests no validamos via stdout (validamos contra
// la instancia de Metrics o el comportamiento del handler), así que filtramos.
// -----------------------------------------------------------------------------
const realConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].startsWith('{"_aws":')) {
    return; // EMF line; suprimida en tests
  }
  realConsoleLog(...args);
};
