import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import type { ErrorKind } from '../shared/schemas.js';
import { redact } from './security/redact.js';

export function apiError(c: Context, status: ContentfulStatusCode, kind: ErrorKind, message: string, action: string) {
  return c.json({ error: { kind, message: redact(message), action } }, status);
}

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly kind: ErrorKind,
    message: string,
    readonly action: string,
  ) {
    super(message);
  }
}

export async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_request', 'El cuerpo de la solicitud no es JSON válido.', 'Revisa los datos enviados.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; ');
    throw new HttpError(400, 'invalid_request', `Datos no válidos (${detail}).`, 'Corrige los campos indicados.');
  }
  return parsed.data;
}
