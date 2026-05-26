import { z } from 'zod';

/**
 * Schema del body HTTP del webhook según el contrato del .docx (sección 2.2):
 *
 *   {
 *     "transaccionId": "TX-12345",
 *     "referencia":    "AB12CD34",
 *     "clienteRut":    "11.111.111-1",
 *     "monto":         5000,
 *     "timestamp":     "2026-05-19T14:30:00Z"
 *   }
 *
 * Decisiones del schema:
 *   - `transaccionId`: string no vacío. Es el PK de la tabla `pagos`.
 *   - `referencia`:    string no vacío. Identificador legible para soporte.
 *   - `clienteRut`:    string no vacío. NO validamos formato RUT chileno con dígito
 *                      verificador acá; eso es lógica de negocio del Processor si
 *                      se requiriera. Mantenemos el Receiver "delgado".
 *   - `monto`:         number positivo. Sin decimales en pesos chilenos pero NO
 *                      restringimos `.int()` por si PayHub usa otra moneda.
 *   - `timestamp`:     ISO 8601. `.datetime()` valida formato `YYYY-MM-DDTHH:mm:ssZ`.
 */
export const webhookBodySchema = z.object({
  transaccionId: z.string().min(1, 'transaccionId requerido'),
  referencia: z.string().min(1, 'referencia requerida'),
  clienteRut: z.string().min(1, 'clienteRut requerido'),
  monto: z.number().positive('monto debe ser positivo'),
  timestamp: z.string().datetime({ message: 'timestamp debe ser ISO 8601' }),
});

export type WebhookBody = z.infer<typeof webhookBodySchema>;

/**
 * Schema del mensaje que el Receiver encola a SQS y el Processor consume.
 *
 * Diferencia con `webhookBodySchema`:
 *   - Wrappea el `payload` original con metadatos de routing (`idempotencyKey`,
 *     `correlationId`, `ingestionTimestamp`).
 *   - El Processor NO debería leer headers HTTP (no los tiene), por eso el
 *     `idempotencyKey` viaja en el body del mensaje.
 *   - `correlationId` se propaga para que los logs del Processor compartan ID
 *     con los del Receiver — visibilidad end-to-end de un webhook.
 *   - `ingestionTimestamp` registra cuándo el Receiver lo aceptó (≠ `payload.timestamp`,
 *     que es cuando PayHub generó el evento).
 */
export const webhookMessageSchema = z.object({
  idempotencyKey: z.string().min(1),
  correlationId: z.string().min(1),
  ingestionTimestamp: z.string().datetime(),
  payload: webhookBodySchema,
});

export type WebhookMessage = z.infer<typeof webhookMessageSchema>;

/**
 * Schema legacy de los fixtures provistos por Altera
 * (`Template_B2_Serverless/sample-events/`).
 *
 * Los fixtures usan un shape más simple — anterior al contrato del .docx —
 * porque fueron creados como muestra. Para que `batch-partial-failure.json`
 * funcione literal contra nuestro Processor (msg-103 falla, los otros 4 pasan),
 * aceptamos este shape también y lo normalizamos al `WebhookMessage` canónico.
 *
 * Ver D18 en `DECISIONS.md` para el razonamiento.
 */
export const legacyWebhookMessageSchema = z.object({
  cobroId: z.string().min(1),
  monto: z.number().positive(),
  clienteRut: z.string().min(1),
  // Campos opcionales presentes en valid-webhook.json pero no en batch-partial-failure.json:
  eventoId: z.string().optional(),
  tipo: z.string().optional(),
  timestamp: z.string().optional(),
});

export type LegacyWebhookMessage = z.infer<typeof legacyWebhookMessageSchema>;

/**
 * Union: el Processor acepta cualquiera de las dos formas.
 * `safeParse` intenta `webhookMessageSchema` primero (el shape moderno que produce
 * nuestro Receiver) y cae al legacy si no calza.
 */
export const anyWebhookMessageSchema = z.union([
  webhookMessageSchema,
  legacyWebhookMessageSchema,
]);

/**
 * Normaliza cualquier shape válido al `WebhookMessage` canónico.
 *
 *   - Shape moderno → se devuelve tal cual.
 *   - Shape legacy  → se rellenan los metadatos faltantes:
 *       - `idempotencyKey`     ← `eventoId ?? cobroId`
 *       - `correlationId`      ← mismo idempotencyKey (consistencia downstream)
 *       - `ingestionTimestamp` ← ahora (no tenemos info de cuándo llegó al Receiver)
 *       - `payload.transaccionId` ← `cobroId` (el ID que tenemos)
 *       - `payload.referencia` ← `eventoId ?? "LEGACY-" + cobroId`
 *       - `payload.timestamp`  ← `timestamp ?? ahora`
 *
 * Falla con error de Zod si NINGUNO de los shapes calza.
 */
export function normalizeWebhookMessage(raw: unknown): WebhookMessage {
  const parsed = anyWebhookMessageSchema.parse(raw);

  // Discriminador: el shape moderno tiene `payload`, el legacy tiene `cobroId`.
  if ('payload' in parsed) {
    return parsed;
  }

  const now = new Date().toISOString();
  const id = parsed.eventoId ?? parsed.cobroId;

  return {
    idempotencyKey: id,
    correlationId: id,
    ingestionTimestamp: now,
    payload: {
      transaccionId: parsed.cobroId,
      referencia: parsed.eventoId ?? `LEGACY-${parsed.cobroId}`,
      clienteRut: parsed.clienteRut,
      monto: parsed.monto,
      timestamp: parsed.timestamp ?? now,
    },
  };
}
