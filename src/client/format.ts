import type { CostClass, ErrorKind, Message, Usage } from '../shared/schemas.js';

export function costLabel(c: CostClass): string {
  return {
    free: 'gratuito',
    low: 'económico',
    standard: 'de pago',
    premium: 'de pago (alto)',
    unknown: 'coste desconocido',
  }[c];
}

export function statusLabel(s: Message['status']): string {
  return { complete: 'Completada', streaming: 'Generando…', cancelled: 'Detenida', error: 'Error' }[s];
}

export function errorKindLabel(k: ErrorKind): string {
  return {
    rate_limit: 'Límite o cuota',
    server: 'Error del proveedor',
    timeout: 'Tiempo agotado',
    network: 'Sin conexión',
    auth: 'Autenticación',
    forbidden: 'Acceso denegado',
    model_unavailable: 'Modelo no disponible',
    invalid_request: 'Solicitud no válida',
    config: 'Configuración',
    cancelled: 'Detenida',
    policy: 'Política de uso',
    unknown: 'Error desconocido',
  }[k];
}

/** Distingue coste reportado, estimado y desconocido; nunca los mezcla. */
export function usageLabel(u: Usage | null): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.promptTokens !== null || u.completionTokens !== null) {
    parts.push(`${u.promptTokens ?? '?'} → ${u.completionTokens ?? '?'} tokens`);
  }
  if (u.costKind === 'unknown' || u.cost === null) parts.push('coste desconocido');
  else parts.push(`${u.costKind === 'reported' ? 'coste reportado' : 'coste estimado'}: ${u.cost.toFixed(6)} (unidad informada por el proveedor)`);
  return parts.join(' · ');
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es');
}
