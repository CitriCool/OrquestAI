import { planContentSchema, type PlanContent } from '../../shared/schemas.js';

export type PlanParseResult = { ok: true; content: PlanContent } | { ok: false; errors: string[] };

/**
 * Extrae el objeto JSON de la respuesta del modelo. Acepta el JSON solo,
 * dentro de un bloque ```json o rodeado de texto.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('La respuesta no contiene un objeto JSON.');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new Error(`El JSON no es válido: ${(err as Error).message}`);
  }
}

/**
 * Valida el plan: formato (esquema) y coherencia (identificadores únicos,
 * dependencias existentes y sin ciclos, agentes disponibles).
 */
export function parsePlan(text: string, availableAgentIds: string[]): PlanParseResult {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }

  const parsed = planContentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`),
    };
  }
  const content = parsed.data;
  const errors: string[] = [];

  const ids = content.subtasks.map((s) => s.id);
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicated.length) errors.push(`Identificadores de subtarea repetidos: ${[...new Set(duplicated)].join(', ')}.`);

  const agents = new Set(availableAgentIds);
  for (const s of content.subtasks) {
    if (!agents.has(s.agentId)) {
      errors.push(`La subtarea «${s.id}» usa el agente «${s.agentId}», que no existe o está deshabilitado.`);
    }
    for (const dep of s.dependsOn) {
      if (dep === s.id) errors.push(`La subtarea «${s.id}» depende de sí misma.`);
      else if (!ids.includes(dep)) errors.push(`La subtarea «${s.id}» depende de «${dep}», que no existe.`);
    }
  }

  if (errors.length === 0) {
    const cycle = findCycle(content);
    if (cycle) errors.push(`Las dependencias forman un ciclo: ${cycle.join(' → ')}.`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, content };
}

/** Devuelve un ciclo de dependencias si existe (búsqueda en profundidad). */
function findCycle(content: PlanContent): string[] | null {
  const deps = new Map(content.subtasks.map((s) => [s.id, s.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };

  for (const id of deps.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

/** Orden de ejecución que respeta las dependencias (para mostrarlo y para el Sprint 2.3). */
export function executionOrder(content: PlanContent): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const pending = [...content.subtasks];
  while (pending.length) {
    const i = pending.findIndex((s) => s.dependsOn.every((d) => done.has(d)));
    if (i < 0) break; // no ocurre con un plan validado
    const [s] = pending.splice(i, 1);
    order.push(s!.id);
    done.add(s!.id);
  }
  return order;
}
