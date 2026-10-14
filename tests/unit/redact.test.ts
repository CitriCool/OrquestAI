import { afterEach, describe, expect, it } from 'vitest';
import { clearRegisteredSecrets, redact, registerSecret } from '../../src/server/security/redact.js';

afterEach(() => clearRegisteredSecrets());

describe('redacción de secretos', () => {
  it('oculta secretos registrados', () => {
    registerSecret('mi-clave-super-secreta');
    expect(redact('falló con mi-clave-super-secreta en la URL')).toBe('falló con [REDACTADO] en la URL');
  });

  it('oculta patrones de claves y cabeceras Bearer aunque no estén registrados', () => {
    expect(redact('key sk-or-v1-abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnop');
    expect(redact('Authorization: Bearer abc.def-ghijklmnop')).not.toContain('abc.def');
  });
});
