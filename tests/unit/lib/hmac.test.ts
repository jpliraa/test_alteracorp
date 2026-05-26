import { createHmac } from 'node:crypto';
import { verifySignature } from '../../../src/lib/hmac';

const SECRET = 'test-secret-payhub';

/**
 * Helper: genera una firma HMAC válida para usar en los tests.
 * Replica la lógica de PayHub firmando el body.
 */
function sign(body: string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifySignature', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('devuelve true cuando la firma es válida (caso típico de PayHub)', () => {
      const body = JSON.stringify({
        transaccionId: 'TX-12345',
        referencia: 'AB12CD34',
        clienteRut: '11.111.111-1',
        monto: 5000,
        timestamp: '2026-05-19T14:30:00Z',
      });
      const signature = sign(body);

      expect(verifySignature(body, signature, SECRET)).toBe(true);
    });

    it('acepta firma en mayúsculas (hex es case-insensitive)', () => {
      const body = '{"a":1}';
      const signature = sign(body).toUpperCase();

      expect(verifySignature(body, signature, SECRET)).toBe(true);
    });

    it('acepta firma con mezcla de mayúsculas y minúsculas', () => {
      const body = '{"a":1}';
      const valid = sign(body);
      // Alternamos case de cada char
      const mixed = valid
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join('');

      expect(verifySignature(body, mixed, SECRET)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Firmas inválidas
  // -------------------------------------------------------------------------
  describe('firmas inválidas', () => {
    it('devuelve false con firma incorrecta (otro body firmado)', () => {
      const body = '{"transaccionId":"TX-1","monto":5000}';
      const badSignature = sign('{"transaccionId":"TX-2","monto":5000}');

      expect(verifySignature(body, badSignature, SECRET)).toBe(false);
    });

    it('devuelve false si el secret usado para firmar fue distinto', () => {
      const body = '{"a":1}';
      const signature = sign(body, 'otro-secret-distinto');

      expect(verifySignature(body, signature, SECRET)).toBe(false);
    });

    it('devuelve false si el body fue modificado en tránsito (un solo char)', () => {
      const original = '{"monto":5000}';
      const tampered = '{"monto":9000}';
      const signature = sign(original);

      expect(verifySignature(tampered, signature, SECRET)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Longitudes y formatos inválidos — NUNCA debe propagar el RangeError
  // de timingSafeEqual
  // -------------------------------------------------------------------------
  describe('longitudes y formatos inválidos', () => {
    it('devuelve false si la firma es más corta (truncada)', () => {
      const body = '{"a":1}';
      // SHA-256 hex = 64 chars; truncamos a 30
      const signature = sign(body).substring(0, 30);

      expect(verifySignature(body, signature, SECRET)).toBe(false);
    });

    it('devuelve false si la firma es más larga (con padding extra)', () => {
      const body = '{"a":1}';
      const signature = sign(body) + 'ab';

      expect(verifySignature(body, signature, SECRET)).toBe(false);
    });

    it('devuelve false con signature que contiene chars no-hex', () => {
      const body = '{"a":1}';
      // 64 chars pero con XXXX al final (no-hex)
      const signature =
        'abcd'.repeat(15) + 'XXXX';

      expect(verifySignature(body, signature, SECRET)).toBe(false);
    });

    it('devuelve false con signature de longitud impar (hex inválido por def)', () => {
      const body = '{"a":1}';
      // 63 chars (impar): Buffer.from('hex') trunca silenciosamente
      const signature = sign(body).substring(0, 63);

      expect(verifySignature(body, signature, SECRET)).toBe(false);
    });

    it('devuelve false con string completamente arbitrario en signature', () => {
      const body = '{"a":1}';
      const signature = 'este-no-es-un-hmac-valido-XXXX';

      expect(verifySignature(body, signature, SECRET)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Inputs vacíos — guard defensivo
  // -------------------------------------------------------------------------
  describe('inputs vacíos', () => {
    it('devuelve false con body vacío', () => {
      const signature = sign('');
      expect(verifySignature('', signature, SECRET)).toBe(false);
    });

    it('devuelve false con signature vacía', () => {
      expect(verifySignature('{"a":1}', '', SECRET)).toBe(false);
    });

    it('devuelve false con secret vacío', () => {
      expect(verifySignature('{"a":1}', 'abcd', '')).toBe(false);
    });

    it('devuelve false con los tres inputs vacíos', () => {
      expect(verifySignature('', '', '')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // No propaga excepciones: clave para que el handler responda 401 limpio
  // -------------------------------------------------------------------------
  describe('no propaga excepciones', () => {
    it('no tira con buffers de tamaño 0', () => {
      expect(() => verifySignature('', '', SECRET)).not.toThrow();
    });

    it('no tira cuando las longitudes difieren (caso que rompería timingSafeEqual)', () => {
      expect(() => verifySignature('{"a":1}', 'ab', SECRET)).not.toThrow();
    });

    it('no tira con chars no-hex en signature', () => {
      expect(() => verifySignature('{"a":1}', '!!!!', SECRET)).not.toThrow();
    });

    it('no tira con body que contiene caracteres unicode (acentos, emojis)', () => {
      const body = '{"saludo":"hola 🚀","cliente":"María José"}';
      const signature = sign(body);

      expect(() => verifySignature(body, signature, SECRET)).not.toThrow();
      expect(verifySignature(body, signature, SECRET)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Sensibilidad: cambios mínimos deben invalidar
  // -------------------------------------------------------------------------
  describe('sensibilidad a cambios mínimos', () => {
    it('detecta diferencia al final de la firma (último char)', () => {
      const body = '{"a":1}';
      const valid = sign(body);
      const lastChar = valid[valid.length - 1] as string;
      const replacement = lastChar === '0' ? '1' : '0';
      const tampered = valid.slice(0, -1) + replacement;

      expect(verifySignature(body, tampered, SECRET)).toBe(false);
    });

    it('detecta diferencia al principio de la firma (primer char)', () => {
      const body = '{"a":1}';
      const valid = sign(body);
      const firstChar = valid[0] as string;
      const replacement = firstChar === '0' ? '1' : '0';
      const tampered = replacement + valid.slice(1);

      expect(verifySignature(body, tampered, SECRET)).toBe(false);
    });

    it('detecta diferencia en el medio de la firma', () => {
      const body = '{"a":1}';
      const valid = sign(body);
      const mid = Math.floor(valid.length / 2);
      const midChar = valid[mid] as string;
      const replacement = midChar === '0' ? '1' : '0';
      const tampered = valid.slice(0, mid) + replacement + valid.slice(mid + 1);

      expect(verifySignature(body, tampered, SECRET)).toBe(false);
    });
  });
});
