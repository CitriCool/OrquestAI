import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { apiError } from '../http.js';

export const TOKEN_HEADER = 'x-orquestai-token';

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function allowedHosts(apiPort: number, devPort = 5173): Set<string> {
  const hosts = new Set<string>();
  for (const name of ['127.0.0.1', 'localhost']) {
    hosts.add(`${name}:${apiPort}`);
    hosts.add(`${name}:${devPort}`);
  }
  return hosts;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Protege la API local frente a otras páginas abiertas en el navegador:
 * - Host permitido (evita DNS rebinding).
 * - Origin, si existe, debe ser local.
 * - Token por arranque en cada petición, salvo la que lo entrega.
 */
export function localGuard(opts: { hosts: Set<string>; token: string }): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!opts.hosts.has(host)) {
      return apiError(c, 403, 'forbidden', 'Origen de la solicitud no permitido.', 'Abre la aplicación desde http://127.0.0.1.');
    }
    const origin = c.req.header('origin');
    if (origin) {
      let originHost = '';
      try {
        const u = new URL(origin);
        originHost = u.protocol === 'http:' ? u.host : '';
      } catch {
        originHost = '';
      }
      if (!opts.hosts.has(originHost)) {
        return apiError(c, 403, 'forbidden', 'Origen de la solicitud no permitido.', 'Abre la aplicación desde http://127.0.0.1.');
      }
    }
    const fetchSite = c.req.header('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return apiError(c, 403, 'forbidden', 'Solicitud entre sitios rechazada.', 'Abre la aplicación desde http://127.0.0.1.');
    }

    const isSessionRequest = c.req.method === 'GET' && c.req.path === '/api/session';
    if (!isSessionRequest) {
      const given = c.req.header(TOKEN_HEADER) ?? '';
      if (!safeEqual(given, opts.token)) {
        return apiError(c, 401, 'auth', 'Sesión local no válida.', 'Recarga la página para obtener una sesión nueva.');
      }
    }
    await next();
  };
}
