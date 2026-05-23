import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Receiver Lambda — webhook PayHub.
 *
 * Flujo (Tarea 4 del enunciado):
 *  1. Verificar firma HMAC (X-PayHub-Signature) → 401 si falla.
 *  2. Validar presencia de headers obligatorios → 400 si falta alguno.
 *  3. Parsear body con Zod → 400 si falla.
 *  4. PutItem condicional en `idempotency_keys` con
 *     ConditionExpression: 'attribute_not_exists(idempotencyKey)'.
 *       - Si la condición falla (ConditionalCheckFailedException) → 200 already_processed (NO encolar).
 *  5. SendMessage a SQS con el evento serializado + correlationId.
 *  6. Responder 202 accepted con { status, idempotencyKey }.
 *
 * Errores inesperados → 500 con body genérico (NUNCA exponer stack).
 *
 * Implementación completa: Fase 4.
 */
export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // TODO Fase 4: implementar flujo de 6 pasos.
  return {
    statusCode: 501,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'not_implemented' }),
  };
};
