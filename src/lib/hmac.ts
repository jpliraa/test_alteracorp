import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Computa el HMAC-SHA256 hex de `body` usando `secret`.
 *
 * NO exportada a propósito: el handler debe usar `verifySignature` (comparación
 * timing-safe), no esta función directamente. Exponerla invita a alguien a
 * escribir `received === computeSignature(body, secret)` — el bug que queremos
 * prevenir (timing attack).
 */
function computeSignatureHex(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Verifica que `signature` (string hex del header `X-PayHub-Signature`)
 * corresponda al HMAC-SHA256 de `body` con `secret`.
 *
 * Reglas y guards (todos validados por tests/unit/lib/hmac.test.ts):
 *
 *   1. Comparación timing-safe via `crypto.timingSafeEqual`.
 *      NUNCA se usa `===` para comparar bytes/strings de la firma.
 *
 *   2. `timingSafeEqual` lanza `RangeError` si los buffers tienen distinta
 *      longitud. Esta función NUNCA propaga ese throw: si las longitudes
 *      difieren, devuelve `false`.
 *
 *   3. Si la firma no es hex válido (chars fuera de [0-9a-fA-F]) → `false`
 *      sin reventar. Sin esta validación, `Buffer.from('xyz', 'hex')`
 *      produciría un buffer silenciosamente truncado y la comparación
 *      seguiría adelante con basura.
 *
 *   4. Inputs vacíos (`body`, `signature` o `secret` vacíos) → `false`
 *      sin reventar. PayHub nunca debería mandarlos, pero defendemos
 *      contra clientes mal configurados.
 *
 *   5. Body se trata como UTF-8 (es JSON; el contrato del enunciado lo
 *      especifica como string). `createHmac.update(body, 'utf8')` lo
 *      asegura aunque el body venga con caracteres acentuados o emojis.
 *
 * @param body      cuerpo crudo del request HTTP (string, sin parsear).
 * @param signature valor del header `X-PayHub-Signature` (hex string).
 * @param secret    `PAYHUB_HMAC_SECRET` — secreto compartido con PayHub.
 * @returns `true` si y solo si la firma es válida; `false` en cualquier
 *          otro caso (incluidos errores de formato e inputs vacíos).
 *
 * @example
 * ```ts
 * const ok = verifySignature(rawBody, headers['x-payhub-signature'] ?? '', secret);
 * if (!ok) return { statusCode: 401, body: JSON.stringify({ status: 'unauthorized' }) };
 * ```
 */
export function verifySignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  // (4) Guard de inputs vacíos. Cualquiera de los tres vacíos → falso.
  //     Usamos comparación directa con cadena vacía (no es comparación de HMAC,
  //     es comparación de presencia — `===` con `''` está OK acá).
  if (body === '' || signature === '' || secret === '') {
    return false;
  }

  // (3) Guard de formato hex. SHA-256 hex SIEMPRE es 64 chars de [0-9a-fA-F].
  //     Validamos con regex antes de Buffer.from('hex') para evitar el
  //     comportamiento silencioso de truncado con chars inválidos o longitud impar.
  if (!/^[0-9a-fA-F]+$/.test(signature)) {
    return false;
  }

  // Calculamos el HMAC esperado y materializamos ambos como Buffer de bytes.
  const expectedHex = computeSignatureHex(body, secret);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const receivedBuf = Buffer.from(signature, 'hex');

  // (2) Guard de longitudes. timingSafeEqual EXIGE buffers del mismo tamaño;
  //     si no, lanza RangeError. Aquí devolvemos false silencioso —
  //     una firma de distinta longitud es trivialmente inválida.
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  // (1) Comparación timing-safe: el tiempo de ejecución NO depende de en qué
  //     byte difieren los buffers. Es la única defensa contra timing attacks.
  return timingSafeEqual(expectedBuf, receivedBuf);
}
