import type { ErrorKind } from '../../shared/schemas.js';
import { redact } from '../security/redact.js';
import { ProviderError } from './types.js';

const MESSAGES: Record<ErrorKind, { message: string; action: string; retryable: boolean }> = {
  rate_limit: {
    message: 'El proveedor limitó las solicitudes o se agotó la cuota disponible.',
    action: 'Espera unos minutos o elige otro modelo.',
    retryable: true,
  },
  server: {
    message: 'El proveedor tuvo un error interno.',
    action: 'Vuelve a intentarlo más tarde o elige otro modelo.',
    retryable: true,
  },
  timeout: {
    message: 'El proveedor no respondió dentro del tiempo máximo.',
    action: 'Vuelve a intentarlo o elige un modelo más rápido.',
    retryable: true,
  },
  network: {
    message: 'No se pudo conectar con el proveedor.',
    action: 'Revisa tu conexión a internet y vuelve a intentarlo.',
    retryable: true,
  },
  auth: {
    message: 'El proveedor rechazó la clave API.',
    action: 'Revisa la clave en el archivo .env y reinicia la aplicación.',
    retryable: false,
  },
  forbidden: {
    message: 'El proveedor denegó el acceso a este modelo.',
    action: 'Revisa los permisos, el saldo o la configuración de privacidad de tu cuenta en el proveedor.',
    retryable: false,
  },
  model_unavailable: {
    message: 'El modelo no existe o no está disponible en este momento.',
    action: 'Elige otro modelo en Modelos y proveedores.',
    retryable: false,
  },
  invalid_request: {
    message: 'El proveedor rechazó la solicitud por no ser válida.',
    action: 'Revisa el mensaje o reduce su longitud.',
    retryable: false,
  },
  config: {
    message: 'El proveedor no está configurado.',
    action: 'Añade la clave API en el archivo .env y reinicia la aplicación.',
    retryable: false,
  },
  cancelled: {
    message: 'La respuesta se detuvo a petición tuya.',
    action: 'Puedes enviar un mensaje nuevo cuando quieras.',
    retryable: false,
  },
  policy: {
    message: 'La política de uso no permite esta llamada.',
    action: 'Revisa la configuración de modelos y costes.',
    retryable: false,
  },
  unknown: {
    message: 'Ocurrió un error inesperado con el proveedor.',
    action: 'Vuelve a intentarlo; si se repite, revisa el registro del servidor.',
    retryable: false,
  },
};

export function providerError(kind: ErrorKind, extra: { status?: number; retryAfterMs?: number; detail?: string } = {}) {
  const base = MESSAGES[kind];
  let message = base.message;
  if (extra.detail) message += ` Detalle: ${redact(extra.detail).slice(0, 300)}`;
  let action = base.action;
  if (extra.retryAfterMs !== undefined) {
    action = `El proveedor pide esperar ${Math.ceil(extra.retryAfterMs / 1000)} s antes de reintentar. ${action}`;
  }
  return new ProviderError(kind, message, action, {
    status: extra.status,
    retryAfterMs: extra.retryAfterMs,
    retryable: base.retryable,
  });
}

/** Interpreta la cabecera Retry-After (segundos o fecha HTTP). */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

const MODEL_HINT = /(model|modelo).{0,40}(not found|not exist|no endpoints|not available|invalid|unknown)|no endpoints found/i;

/** Clasifica una respuesta HTTP fallida. No todos los errores son de cuota. */
export function classifyHttpError(status: number, bodyText: string, retryAfter?: string | null): ProviderError {
  const detail = extractErrorMessage(bodyText);
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (status === 429) return providerError('rate_limit', { status, retryAfterMs, detail });
  if (status === 401) return providerError('auth', { status });
  if (status === 402) {
    return providerError('forbidden', { status, detail: detail || 'Saldo o créditos insuficientes.' });
  }
  if (status === 403) return providerError('forbidden', { status, detail });
  if (status === 404) return providerError('model_unavailable', { status, detail });
  if (status === 408) return providerError('timeout', { status });
  if (status >= 500) return providerError('server', { status, retryAfterMs, detail });
  if (status === 400 || status === 422) {
    return providerError(MODEL_HINT.test(detail) ? 'model_unavailable' : 'invalid_request', { status, detail });
  }
  return providerError('unknown', { status, detail });
}

/** Clasifica un error lanzado (red, tiempo, cancelación). */
export function classifyThrown(error: unknown, ctx: { userAborted: boolean; timedOut: boolean }): ProviderError {
  if (error instanceof ProviderError) return error;
  if (ctx.userAborted) return providerError('cancelled');
  if (ctx.timedOut) return providerError('timeout');
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return providerError('timeout');
  }
  if (error instanceof TypeError) {
    // fetch lanza TypeError ante fallos de red/DNS/TLS.
    return providerError('network', { detail: error.cause instanceof Error ? error.cause.message : error.message });
  }
  return providerError('unknown', { detail: error instanceof Error ? error.message : String(error) });
}

function extractErrorMessage(bodyText: string): string {
  if (!bodyText) return '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // no es JSON
  }
  return bodyText.slice(0, 300);
}
