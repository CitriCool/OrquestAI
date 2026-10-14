import { describe, expect, it } from 'vitest';
import { classifyHttpError, classifyThrown, parseRetryAfter } from '../../src/server/providers/errors.js';

describe('clasificación de errores del proveedor', () => {
  it('distingue cada código HTTP y no trata todo como cuota', () => {
    expect(classifyHttpError(429, '').kind).toBe('rate_limit');
    expect(classifyHttpError(500, '').kind).toBe('server');
    expect(classifyHttpError(503, '').kind).toBe('server');
    expect(classifyHttpError(401, '').kind).toBe('auth');
    expect(classifyHttpError(402, '').kind).toBe('forbidden');
    expect(classifyHttpError(403, '').kind).toBe('forbidden');
    expect(classifyHttpError(404, '').kind).toBe('model_unavailable');
    expect(classifyHttpError(408, '').kind).toBe('timeout');
    expect(classifyHttpError(400, '{"error":{"message":"bad"}}').kind).toBe('invalid_request');
    expect(classifyHttpError(400, '{"error":{"message":"No endpoints found for x"}}').kind).toBe('model_unavailable');
  });

  it('marca como reintentables solo los errores temporales', () => {
    expect(classifyHttpError(429, '').retryable).toBe(true);
    expect(classifyHttpError(502, '').retryable).toBe(true);
    expect(classifyHttpError(401, '').retryable).toBe(false);
    expect(classifyHttpError(400, '').retryable).toBe(false);
  });

  it('respeta Retry-After en segundos y como fecha', () => {
    const e = classifyHttpError(429, '', '12');
    expect(e.opts.retryAfterMs).toBe(12_000);
    expect(e.action).toContain('12 s');
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('basura')).toBeUndefined();
  });

  it('clasifica errores lanzados: cancelación, tiempo y red', () => {
    expect(classifyThrown(new Error('x'), { userAborted: true, timedOut: false }).kind).toBe('cancelled');
    expect(classifyThrown(new Error('x'), { userAborted: false, timedOut: true }).kind).toBe('timeout');
    expect(classifyThrown(new TypeError('fetch failed'), { userAborted: false, timedOut: false }).kind).toBe('network');
  });

  it('los mensajes están en español e incluyen una acción', () => {
    const e = classifyHttpError(401, '');
    expect(e.message).toMatch(/clave API/);
    expect(e.action).toMatch(/\.env/);
  });
});
