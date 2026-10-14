import { formatUsd, perMillion } from '../shared/pricing.js';
import type {
  ComplexityLevel,
  CostClass,
  CostMode,
  ModelInfo,
  ErrorKind,
  Message,
  PlanStatus,
  ReviewLevel,
  TaskRun,
  TaskStatus,
  Usage,
} from '../shared/schemas.js';

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
  else if (u.costKind === 'reported') parts.push(`coste reportado: ${u.cost === 0 ? '0' : u.cost.toFixed(6)} (créditos del proveedor)`);
  else parts.push(`coste estimado: ${formatUsd(u.cost)}`);
  return parts.join(' · ');
}

export function costModeLabel(m: CostMode): string {
  return { free: 'A · exclusivamente gratuito', economic: 'B · económico', manual: 'C · control manual' }[m];
}

/** Precio por millón de tokens de entrada y de salida, o null si es gratuito o desconocido. */
export function priceLabel(m: Pick<ModelInfo, 'pricing' | 'costClass'>): string | null {
  if (!m.pricing || m.costClass === 'free') return null;
  const f = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(2));
  const parts = [`USD ${f(perMillion(m.pricing.prompt))}/M entrada · ${f(perMillion(m.pricing.completion))}/M salida`];
  if (m.pricing.request > 0) parts.push(`${formatUsd(m.pricing.request)} por solicitud`);
  return parts.join(' · ');
}

export function taskStatusLabel(s: TaskStatus): string {
  return {
    draft: 'Borrador',
    planning: 'Planificando…',
    plan_ready: 'Plan por revisar',
    plan_failed: 'Sin plan válido',
    approved: 'Plan aprobado',
    running: 'Ejecutando…',
    completed: 'Resultado listo',
    interrupted: 'Interrumpida',
    failed: 'Falló la ejecución',
    done: 'Terminada',
    cancelled: 'Cancelada',
  }[s];
}

export function runStatusLabel(s: TaskRun['status']): string {
  return { running: 'En curso', complete: 'Completada', error: 'Error', cancelled: 'Detenida' }[s];
}

export function planStatusLabel(s: PlanStatus): string {
  return { proposed: 'propuesto', approved: 'aprobado', superseded: 'sustituido', invalid: 'no válido' }[s];
}

export function complexityLabel(l: ComplexityLevel): string {
  return { 1: 'Nivel 1 · sencillo', 2: 'Nivel 2 · intermedio', 3: 'Nivel 3 · complejo' }[l];
}

export function reviewLevelLabel(r: ReviewLevel): string {
  return { none: 'Sin revisión', standard: 'Estándar', strict: 'Estricta' }[r];
}

export function runKindLabel(k: TaskRun['kind']): string {
  return {
    plan: 'Plan',
    plan_repair: 'Corrección del plan',
    subtask: 'Subtarea',
    review: 'Revisión crítica',
    review_repair: 'Corrección del formato de la revisión',
    correction: 'Corrección de la subtarea',
    synthesis: 'Síntesis',
  }[k];
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es');
}
