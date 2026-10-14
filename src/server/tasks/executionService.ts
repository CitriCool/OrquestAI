import {
  reviewContentSchema,
  type Agent,
  type ExecuteTaskInput,
  type ExecutionLimits,
  type Plan,
  type PlanContent,
  type PlanSubtask,
  type ReviewContent,
  type ReviewObservation,
  type Task,
} from '../../shared/schemas.js';
import { systemPrompt } from '../chat/chatService.js';
import { HttpError } from '../http.js';
import { assertModelAllowed, requireUsableProvider } from '../policies/modelPolicy.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ProviderError, type ChatTurn, type ProviderAdapter } from '../providers/types.js';
import { log } from '../security/redact.js';
import type { Repository } from '../storage/repository.js';
import type { TaskRepository } from '../storage/taskRepository.js';
import { emptyResponseError, recordedCall } from './modelCall.js';
import { executionOrder, extractJson } from './planParser.js';

export const REVIEWER_ID = 'revisor';
export const SYNTHESIZER_ID = 'sintetizador';

/**
 * Límites de salida por llamada. En la prueba real (14-10-2026) 3.000 tokens
 * cortaban entregas y revisiones; con modelos gratuitos no hay coste extra.
 */
const SUBTASK_MAX_OUTPUT_TOKENS = 6_000;
const REVIEW_MAX_OUTPUT_TOKENS = 6_000;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 8_000;
/** Contexto por llamada: cada resultado previo se recorta para no enviar todo indiscriminadamente. */
const DEPENDENCY_MAX_CHARS = 8_000;
const CONTEXT_MAX_CHARS = 6_000;

const STATES_THAT_CAN_RUN = new Set<Task['status']>(['approved', 'completed', 'interrupted', 'failed']);

const REVIEW_FORMAT = `Revisa los resultados frente al objetivo y a los criterios de aceptación. Devuelve SOLO un objeto JSON válido, sin texto antes ni después:
{
  "verdict": "aprobado" | "requiere_cambios",
  "summary": "valoración general en pocas frases",
  "criteria": [{ "criterion": "texto del criterio", "status": "cumple" | "no_cumple" | "no_verificable", "note": "por qué" }],
  "observations": [
    {
      "id": "o1",
      "problem": "problema concreto",
      "severity": "alta" | "media" | "baja",
      "evidence": "evidencia o razonamiento",
      "criterion": "criterio afectado, si aplica",
      "suggestedFix": "corrección concreta",
      "subtaskId": "id de la subtarea que debe corregirse, o null",
      "status": "pendiente" | "corregido" | "descartado" | "no_verificable",
      "justification": "obligatoria si descartas una observación"
    }
  ]
}
Reglas:
- "alta" = error comprobado que impide cumplir un criterio; "media" = problema real que conviene corregir; "baja" = mejora opcional.
- Distingue errores comprobados de riesgos hipotéticos; no inventes problemas ni apruebes por cortesía.
- Una afirmación técnica que nadie ha ejecutado es "no_verificable", no "cumple".
- Si hay observaciones de una ronda anterior, inclúyelas con su mismo id y su estado actual (corregido, pendiente, descartado con justificación o no_verificable).
- Sé conciso: como máximo 8 observaciones y cada campo en una o dos frases.
- Si no hay observaciones, devuelve "observations": [].`;

const SYNTHESIS_FORMAT = `Integra las aportaciones en la respuesta final para el usuario, en Markdown y en español, con estas secciones:
## Solución final
## Decisiones principales
## Resultado frente a los criterios de aceptación
## Objeciones resueltas y pendientes
## Pruebas ejecutadas y resultados
## Supuestos y limitaciones
Reglas: usa solo lo que respaldan las aportaciones y la revisión; no inventes resultados. En «Pruebas ejecutadas» indica con claridad que el sistema no ejecutó código ni pruebas: las comprobaciones de los agentes son razonamiento del modelo, no una verificación objetiva.`;

type RunState = {
  task: Task;
  plan: Plan & { content: PlanContent };
  limits: ExecutionLimits;
  execution: number;
  calls: number;
  controller: AbortController;
  defaultProvider: ProviderAdapter;
  defaultModelId: string;
  agents: Map<string, Agent>;
  limitations: string[];
};

export class ExecutionService {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly repo: Repository,
    private readonly tasks: TaskRepository,
    private readonly providers: ProviderRegistry,
    private readonly timeoutMs: number,
  ) {}

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /**
   * Comprueba el plan aprobado, los agentes y todos los modelos que se
   * usarán (política y aviso) antes de empezar; después ejecuta en segundo plano.
   */
  async start(taskId: string, input: ExecuteTaskInput, isPlanning: (id: string) => boolean): Promise<void> {
    const task = this.tasks.getTask(taskId);
    if (!task) throw new HttpError(404, 'invalid_request', 'La tarea no existe.', 'Vuelve a la lista de tareas.');
    if (this.active.has(taskId) || isPlanning(taskId) || !STATES_THAT_CAN_RUN.has(task.status)) {
      throw new HttpError(
        409,
        'invalid_request',
        task.status === 'running' ? 'La tarea ya se está ejecutando.' : 'La tarea necesita un plan aprobado para ejecutarse.',
        'Revisa el estado de la tarea.',
      );
    }
    const plan = this.tasks.currentPlan(taskId);
    if (plan?.status !== 'approved' || !plan.content || !plan.limits) {
      throw new HttpError(409, 'invalid_request', 'No hay un plan aprobado.', 'Aprueba el plan antes de ejecutarlo.');
    }

    const agents = new Map(this.repo.listAgents().map((a) => [a.id, a]));
    const needed = [
      ...new Set([
        ...plan.content.subtasks.map((s) => s.agentId),
        ...(task.reviewLevel === 'none' ? [] : [REVIEWER_ID]),
        ...(plan.content.subtasks.length > 1 ? [SYNTHESIZER_ID] : []),
      ]),
    ];
    const disabled = needed.filter((id) => !agents.get(id)?.enabled);
    if (disabled.length) {
      throw new HttpError(
        409,
        'policy',
        `Hay agentes del plan que no existen o están deshabilitados: ${disabled.join(', ')}.`,
        'Habilítalos en Agentes o pide una nueva versión del plan.',
      );
    }

    // Todos los modelos se verifican antes de la primera llamada: no se descubre a mitad de camino.
    const defaultProvider = requireUsableProvider(this.providers, this.repo, input.providerId);
    const models = new Map<string, ProviderAdapter>([[`${defaultProvider.id}\n${input.modelId}`, defaultProvider]]);
    for (const id of needed) {
      const a = agents.get(id)!;
      if (a.providerId && a.modelId) {
        models.set(`${a.providerId}\n${a.modelId}`, requireUsableProvider(this.providers, this.repo, a.providerId));
      }
    }

    const controller = new AbortController();
    this.active.set(taskId, controller);
    try {
      for (const [key, provider] of models) await assertModelAllowed(provider, key.split('\n')[1]!);
    } catch (err) {
      this.active.delete(taskId);
      throw err;
    }

    const state: RunState = {
      task,
      plan: plan as RunState['plan'],
      limits: plan.limits,
      execution: this.tasks.nextExecution(taskId),
      calls: 0,
      controller,
      defaultProvider,
      defaultModelId: input.modelId,
      agents,
      limitations: [],
    };
    this.tasks.setTaskResult(taskId, { status: 'running', result: null, outcome: null, limitations: [] });
    void this.run(state).finally(() => this.active.delete(taskId));
  }

  /** Detiene la ejecución. Los resultados ya obtenidos quedan guardados. */
  cancel(taskId: string): boolean {
    const controller = this.active.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async idle(): Promise<void> {
    while (this.active.size) await new Promise((r) => setTimeout(r, 5));
  }

  // ---- Flujo ----

  private async run(s: RunState): Promise<void> {
    const content = s.plan.content;
    const order = executionOrder(content);
    const byId = new Map(content.subtasks.map((st) => [st.id, st]));
    const outputs = new Map<string, string>();

    try {
      // Etapa 3: subtareas en orden de dependencias. Se guarda cada resultado antes de seguir.
      for (const id of order) {
        if (!this.reserve(s, 1, `No se ejecutó la subtarea «${id}» por el límite de llamadas.`)) break;
        outputs.set(id, await this.runSubtask(s, byId.get(id)!, outputs, 1));
      }

      // Etapas 4 y 5: revisión y, si hace falta, corrección por rondas.
      let review: ReviewContent | null = null;
      if (s.task.reviewLevel !== 'none' && outputs.size === order.length) {
        let previousProblems: string | null = null;
        for (let round = 1; round <= s.limits.maxRounds; round++) {
          if (!this.reserve(s, 1, 'No se pudo completar la revisión por el límite de llamadas.')) break;
          const next = await this.runReview(s, content, outputs, review, round);
          if (!next) break; // revisión no válida: se registra como limitación
          review = next;

          const toFix = this.observationsToFix(review, s.task.reviewLevel);
          if (review.verdict === 'aprobado' || toFix.length === 0) break;
          const problems = toFix.map((o) => normalize(o.problem)).sort().join('|');
          if (problems === previousProblems) {
            s.limitations.push('El revisor repitió las mismas observaciones sin información nueva; se detuvo para no gastar llamadas.');
            break;
          }
          previousProblems = problems;
          if (round === s.limits.maxRounds) {
            s.limitations.push(`Se alcanzó el máximo de ${s.limits.maxRounds} ronda(s) con observaciones pendientes.`);
            break;
          }
          // Corrección por el agente original de cada subtarea afectada.
          const targets = groupBySubtask(toFix, order);
          const synthesisReserve = order.length > 1 ? 1 : 0;
          if (!this.reserve(s, targets.size + 1 + synthesisReserve, 'No hubo llamadas suficientes para otra ronda de corrección y revisión.', true)) break;
          for (const [subtaskId, obs] of targets) {
            this.reserve(s, 1, ''); // cabe: se comprobó arriba
            outputs.set(subtaskId, await this.runCorrection(s, byId.get(subtaskId)!, outputs, obs, round + 1));
          }
        }
      }

      // Etapa 6: síntesis.
      const pending = review ? this.observationsToFix(review, s.task.reviewLevel) : [];
      if (pending.length) s.limitations.push(`Quedan ${pending.length} observación(es) importante(s) sin resolver.`);
      // Si el revisor sigue pidiendo cambios, el resultado no se presenta como completo.
      const minor = review ? review.observations.filter((o) => o.status === 'pendiente' && !pending.includes(o)) : [];
      if (review?.verdict === 'requiere_cambios' && minor.length) {
        s.limitations.push(
          `El revisor pidió cambios que no se aplicaron: ${minor.length} observación(es) de gravedad ${[...new Set(minor.map((o) => o.severity))].join(' o ')}` +
            (s.task.reviewLevel === 'standard' ? ' (la revisión estándar solo corrige las de gravedad alta; usa la estricta para corregir también las medias).' : '.'),
        );
      }
      if (s.task.reviewLevel === 'none') s.limitations.push('La tarea se ejecutó sin revisión crítica.');
      const missing = order.filter((id) => !outputs.has(id));
      let result: string;
      if (order.length > 1 && missing.length === 0 && this.reserve(s, 1, 'No quedó ninguna llamada para la síntesis.')) {
        result = await this.runSynthesis(s, content, outputs, review);
      } else {
        result = composeResult(content, outputs, review, missing);
      }

      this.tasks.setTaskResult(s.task.id, {
        status: 'completed',
        result,
        outcome: s.limitations.length || missing.length ? 'partial' : 'complete',
        limitations: s.limitations,
      });
    } catch (err) {
      const e = err instanceof ProviderError ? err : null;
      if (!this.tasks.getTask(s.task.id)) return; // la tarea se eliminó durante la ejecución
      if (e?.kind === 'cancelled') {
        if (this.tasks.getTask(s.task.id)?.status === 'running') {
          this.tasks.setTaskStatus(s.task.id, 'interrupted', { kind: 'cancelled', message: 'La ejecución se detuvo a petición tuya.' });
        }
        return;
      }
      if (!e) log.error('Error interno al ejecutar la tarea.', err);
      this.tasks.setTaskStatus(s.task.id, 'failed', {
        kind: e?.kind ?? 'unknown',
        message: e ? `${e.message} ${e.action}` : 'Error interno al ejecutar la tarea. Revisa el registro del servidor.',
      });
    }
  }

  /**
   * Control de llamadas: reserva n llamadas si caben en el límite. Con
   * onlyCheck no las consume (se consumen al hacerse cada llamada).
   */
  private reserve(s: RunState, n: number, reason: string, onlyCheck = false): boolean {
    if (s.calls + n > s.limits.maxCalls) {
      if (!s.limitations.includes(reason)) s.limitations.push(reason);
      return false;
    }
    if (!onlyCheck) s.calls += n;
    return true;
  }

  /** Revisión estándar: se corrigen las observaciones de gravedad alta; estricta: también las medias. */
  private observationsToFix(review: ReviewContent, level: Task['reviewLevel']): ReviewObservation[] {
    const severities = level === 'strict' ? ['alta', 'media'] : ['alta'];
    return review.observations.filter((o) => o.status === 'pendiente' && severities.includes(o.severity));
  }

  private modelFor(s: RunState, agent: Agent): { provider: ProviderAdapter; modelId: string } {
    if (agent.providerId && agent.modelId) {
      return { provider: this.providers.get(agent.providerId)!, modelId: agent.modelId };
    }
    return { provider: s.defaultProvider, modelId: s.defaultModelId };
  }

  private async call(
    s: RunState,
    agent: Agent,
    kind: 'subtask' | 'review' | 'review_repair' | 'correction' | 'synthesis',
    round: number | null,
    subtaskId: string | null,
    messages: ChatTurn[],
    opts: { maxOutputTokens: number; json?: boolean },
  ) {
    const { provider, modelId } = this.modelFor(s, agent);
    return recordedCall(
      { repo: this.repo, tasks: this.tasks, timeoutMs: this.timeoutMs },
      {
        run: {
          taskId: s.task.id,
          planId: s.plan.id,
          agentId: agent.id,
          kind,
          execution: s.execution,
          round,
          subtaskId,
          providerId: provider.id,
          modelId,
        },
        provider,
        messages,
        maxOutputTokens: agent.maxOutputTokens ?? opts.maxOutputTokens,
        temperature: agent.temperature ?? undefined,
        responseFormat: opts.json ? 'json' : 'text',
        signal: s.controller.signal,
      },
    );
  }

  /**
   * Revisión y síntesis: si su llamada falla (salvo cancelación), se conserva
   * el trabajo hecho y el fallo queda como limitación del resultado.
   */
  private async stageCall<T>(s: RunState, what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderError && err.kind !== 'cancelled') {
        s.limitations.push(`${what} falló: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  private async runSubtask(s: RunState, st: PlanSubtask, outputs: Map<string, string>, round: number): Promise<string> {
    const agent = s.agents.get(st.agentId)!;
    const { text, finishReason } = await this.call(
      s,
      agent,
      'subtask',
      round,
      st.id,
      [
        { role: 'system', content: systemPrompt(agent) },
        { role: 'user', content: subtaskData(s.task, s.plan.content, st, outputs) },
      ],
      { maxOutputTokens: SUBTASK_MAX_OUTPUT_TOKENS },
    );
    if (!text.trim()) throw new ProviderError('server', emptyResponseError(finishReason, `la subtarea «${st.id}»`), 'Prueba con otro modelo.');
    noteTruncation(s, finishReason, `La entrega de la subtarea «${st.id}»`);
    return text;
  }

  private async runCorrection(
    s: RunState,
    st: PlanSubtask,
    outputs: Map<string, string>,
    observations: ReviewObservation[],
    round: number,
  ): Promise<string> {
    const agent = s.agents.get(st.agentId)!;
    const { text, finishReason } = await this.call(
      s,
      agent,
      'correction',
      round,
      st.id,
      [
        { role: 'system', content: systemPrompt(agent) },
        { role: 'user', content: subtaskData(s.task, s.plan.content, st, outputs) },
        { role: 'assistant', content: clip(outputs.get(st.id) ?? '', DEPENDENCY_MAX_CHARS) },
        {
          role: 'user',
          content: [
            'El Revisor crítico encontró estos problemas en tu entrega. Corrígelos y devuelve la entrega completa corregida.',
            'Si consideras que una observación es incorrecta, explícalo con argumentos en lugar de ignorarla.',
            ...observations.map(
              (o) => `- [${o.id}, gravedad ${o.severity}] ${o.problem}${o.suggestedFix ? ` → Corrección sugerida: ${o.suggestedFix}` : ''}`,
            ),
          ].join('\n'),
        },
      ],
      { maxOutputTokens: SUBTASK_MAX_OUTPUT_TOKENS },
    );
    // Si la corrección llega vacía, se conserva la entrega anterior.
    if (!text.trim()) {
      s.limitations.push(`La corrección de la subtarea «${st.id}» llegó vacía; se conservó la versión anterior.`);
      return outputs.get(st.id)!;
    }
    noteTruncation(s, finishReason, `La corrección de la subtarea «${st.id}»`);
    return text;
  }

  /** Revisión crítica estructurada. Devuelve null si no se obtuvo una revisión válida. */
  private async runReview(
    s: RunState,
    content: PlanContent,
    outputs: Map<string, string>,
    previous: ReviewContent | null,
    round: number,
  ): Promise<ReviewContent | null> {
    const agent = s.agents.get(REVIEWER_ID)!;
    const messages: ChatTurn[] = [
      { role: 'system', content: `${systemPrompt(agent)}\n\n${REVIEW_FORMAT}${strictNote(s.task)}` },
      { role: 'user', content: reviewData(s.task, content, outputs, previous) },
    ];
    let attempt = await this.stageCall(s, `La revisión de la ronda ${round}`, () =>
      this.call(s, agent, 'review', round, null, messages, { maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, json: true }),
    );
    if (!attempt) return null;
    let parsed = parseReview(attempt.text, attempt.finishReason);
    if (!parsed.ok && this.reserve(s, 1, 'No quedó ninguna llamada para corregir el formato de la revisión.')) {
      const truncated = attempt.finishReason === 'length';
      // Una respuesta cortada no se reenvía: solo gastaría tokens.
      if (attempt.text.trim() && !truncated) messages.push({ role: 'assistant', content: attempt.text });
      messages.push({
        role: 'user',
        content: truncated
          ? 'Tu revisión se cortó antes de terminar. Devuelve el objeto JSON completo y MÁS BREVE: como máximo 8 observaciones y cada texto en una o dos frases.'
          : `Tu revisión no tiene el formato pedido. Errores:\n- ${parsed.errors.join('\n- ')}\n\nDevuelve SOLO el objeto JSON corregido.`,
      });
      const repaired = await this.stageCall(s, `La corrección de formato de la revisión de la ronda ${round}`, () =>
        this.call(s, agent, 'review_repair', round, null, messages, { maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, json: true }),
      );
      if (!repaired) return null;
      attempt = repaired;
      parsed = parseReview(attempt.text, attempt.finishReason);
    }
    if (!parsed.ok) {
      s.limitations.push(`La revisión de la ronda ${round} no tuvo un formato válido: ${parsed.errors.slice(0, 2).join('; ')}`);
      return null;
    }
    this.tasks.setRunReview(attempt.run.id, parsed.review);
    return parsed.review;
  }

  private async runSynthesis(
    s: RunState,
    content: PlanContent,
    outputs: Map<string, string>,
    review: ReviewContent | null,
  ): Promise<string> {
    const agent = s.agents.get(SYNTHESIZER_ID)!;
    const response = await this.stageCall(s, 'La síntesis', () =>
      this.call(
        s,
        agent,
        'synthesis',
        null,
        null,
        [
          { role: 'system', content: `${systemPrompt(agent)}\n\n${SYNTHESIS_FORMAT}` },
          { role: 'user', content: synthesisData(s.task, content, outputs, review, s.limitations) },
        ],
        { maxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS },
      ),
    );
    if (!response) return composeResult(content, outputs, review, []);
    const { text, finishReason } = response;
    if (!text.trim()) {
      s.limitations.push(`La síntesis no se generó: ${emptyResponseError(finishReason, 'la síntesis')}`);
      return composeResult(content, outputs, review, []);
    }
    noteTruncation(s, finishReason, 'La síntesis');
    return text;
  }
}

// ---- Ayudas puras (exportadas para las pruebas) ----

/** Una respuesta cortada por el límite de tokens se acepta, pero se declara como limitación. */
function noteTruncation(s: RunState, finishReason: string | null, what: string): void {
  if (finishReason === 'length') {
    s.limitations.push(`${what} se cortó por el límite de tokens de salida y puede estar incompleta.`);
  }
}

function strictNote(task: Task): string {
  return task.reviewLevel === 'strict'
    ? '\n\nNivel de revisión ESTRICTO: examina con detalle seguridad, casos límite y cada criterio.'
    : '';
}

export function parseReview(
  text: string,
  finishReason: string | null,
): { ok: true; review: ReviewContent } | { ok: false; errors: string[] } {
  if (!text.trim()) return { ok: false, errors: [emptyResponseError(finishReason, 'la revisión')] };
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    const cut = finishReason === 'length' ? 'La revisión se cortó por el límite de tokens antes de terminar el JSON. ' : '';
    return { ok: false, errors: [`${cut}${(err as Error).message}`] };
  }
  const parsed = reviewContentSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'revisión'}: ${i.message}`) };
  }
  const missingJustification = parsed.data.observations.filter((o) => o.status === 'descartado' && !o.justification);
  if (missingJustification.length) {
    return {
      ok: false,
      errors: missingJustification.map((o) => `La observación «${o.id}» se descartó sin justificación.`),
    };
  }
  return { ok: true, review: parsed.data };
}

/** Agrupa las observaciones por subtarea; las que no indican una válida van a la última del plan. */
export function groupBySubtask(observations: ReviewObservation[], order: string[]): Map<string, ReviewObservation[]> {
  const groups = new Map<string, ReviewObservation[]>();
  for (const o of observations) {
    const target = o.subtaskId && order.includes(o.subtaskId) ? o.subtaskId : order.at(-1)!;
    groups.set(target, [...(groups.get(target) ?? []), o]);
  }
  return groups;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… recortado: ${text.length - max} caracteres más]` : text;
}

function criteriaBlock(content: PlanContent): string {
  return content.acceptanceCriteria.map((c) => `- ${c}`).join('\n');
}

/** Cada subtarea recibe solo lo necesario: objetivo, criterios, su encargo y los resultados de sus dependencias. */
function subtaskData(task: Task, content: PlanContent, st: PlanSubtask, outputs: Map<string, string>): string {
  const lines = [
    '## Objetivo general',
    content.interpretedObjective,
    task.context ? `\n## Contexto\n${clip(task.context, CONTEXT_MAX_CHARS)}` : '',
    '\n## Criterios de aceptación de la tarea',
    criteriaBlock(content),
    `\n## Tu subtarea (${st.id}): ${st.title}`,
    st.description,
    `Entrega esperada: ${st.expectedOutput}`,
  ];
  for (const dep of st.dependsOn) {
    const out = outputs.get(dep);
    if (out) lines.push(`\n## Resultado de la subtarea previa «${dep}»`, clip(out, DEPENDENCY_MAX_CHARS));
  }
  lines.push('\nEntrega solo tu parte, completa y concreta. Indica supuestos y cómo comprobar el resultado.');
  return lines.filter(Boolean).join('\n');
}

function reviewData(task: Task, content: PlanContent, outputs: Map<string, string>, previous: ReviewContent | null): string {
  const lines = [
    '## Objetivo',
    content.interpretedObjective,
    '\n## Criterios de aceptación',
    criteriaBlock(content),
    `\n## Estrategia de revisión del plan\n${content.reviewStrategy}`,
  ];
  for (const st of content.subtasks) {
    lines.push(`\n## Entrega de la subtarea «${st.id}»: ${st.title}`, clip(outputs.get(st.id) ?? '(sin entrega)', DEPENDENCY_MAX_CHARS));
  }
  if (previous) {
    lines.push('\n## Observaciones de la ronda anterior (indica su estado actual)', JSON.stringify(previous.observations));
  }
  if (task.context) lines.push(`\n## Contexto de la tarea\n${clip(task.context, CONTEXT_MAX_CHARS)}`);
  return lines.join('\n');
}

function synthesisData(
  task: Task,
  content: PlanContent,
  outputs: Map<string, string>,
  review: ReviewContent | null,
  limitations: string[],
): string {
  const lines = ['## Objetivo', content.interpretedObjective, '\n## Criterios de aceptación', criteriaBlock(content)];
  for (const st of content.subtasks) {
    lines.push(`\n## Aportación «${st.id}» (${st.agentId}): ${st.title}`, clip(outputs.get(st.id) ?? '(sin entrega)', DEPENDENCY_MAX_CHARS));
  }
  lines.push(
    '\n## Revisión crítica',
    review ? JSON.stringify(review) : task.reviewLevel === 'none' ? 'La tarea se ejecutó sin revisión.' : 'No se obtuvo una revisión válida.',
  );
  if (limitations.length) lines.push('\n## Limitaciones del proceso', ...limitations.map((l) => `- ${l}`));
  lines.push('\nCoste: solo se usaron modelos gratuitos.');
  return lines.join('\n');
}

/**
 * Resultado sin llamada de síntesis: una sola subtarea, o síntesis no
 * disponible. Se arma solo con lo obtenido, sin añadir afirmaciones.
 */
export function composeResult(
  content: PlanContent,
  outputs: Map<string, string>,
  review: ReviewContent | null,
  missing: string[],
): string {
  const parts: string[] = ['## Solución final'];
  for (const st of content.subtasks) {
    const out = outputs.get(st.id);
    if (content.subtasks.length > 1) parts.push(`### ${st.title}`);
    parts.push(out ?? '_Esta subtarea no se ejecutó._');
  }
  parts.push('## Resultado frente a los criterios de aceptación');
  if (review) {
    parts.push(...review.criteria.map((c) => `- **${c.status.replace('_', ' ')}**: ${c.criterion}${c.note ? ` (${c.note})` : ''}`));
    const open = review.observations.filter((o) => o.status === 'pendiente');
    parts.push('## Objeciones pendientes', open.length ? open.map((o) => `- [${o.severity}] ${o.problem}`).join('\n') : 'Ninguna.');
  } else {
    parts.push('Sin revisión crítica: no se evaluaron los criterios.');
  }
  if (missing.length) parts.push('## Limitaciones', `No se ejecutaron estas subtareas: ${missing.join(', ')}.`);
  parts.push('## Pruebas ejecutadas', 'El sistema no ejecutó código ni pruebas: las comprobaciones son razonamiento de los modelos.');
  return parts.join('\n\n');
}
