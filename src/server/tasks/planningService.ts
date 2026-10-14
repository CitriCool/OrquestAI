import type { Agent, Plan, PlanTaskInput, Task } from '../../shared/schemas.js';
import { systemPrompt } from '../chat/chatService.js';
import { HttpError } from '../http.js';
import type { CostPolicy } from '../policies/costPolicy.js';
import { requireUsableProvider } from '../policies/modelPolicy.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ProviderError, type ChatTurn, type ProviderAdapter } from '../providers/types.js';
import { log } from '../security/redact.js';
import type { Repository } from '../storage/repository.js';
import type { TaskRepository } from '../storage/taskRepository.js';
import { estimateComplexity, executionLimits } from './complexity.js';
import { emptyResponseError, recordedCall } from './modelCall.js';
import { parsePlan } from './planParser.js';

export const COORDINATOR_ID = 'coordinador';
/** Primer intento + una corrección: control explícito del número de llamadas. */
const MAX_PLAN_ATTEMPTS = 2;
const PLAN_MAX_OUTPUT_TOKENS = 4_000;
const PLAN_TEMPERATURE = 0.2;
/**
 * La revisión y la síntesis son etapas fijas del flujo (Sprint 2.3): esos
 * agentes no se asignan a subtareas, igual que el propio Coordinador.
 */
const STAGE_ROLES = new Set<Agent['role']>(['coordinator', 'reviewer', 'synthesizer']);

const PLAN_FORMAT = `Tu tarea ahora es PLANIFICAR, no resolver. Devuelve SOLO un objeto JSON válido, sin texto antes ni después y sin comentarios, con esta forma exacta:
{
  "interpretedObjective": "objetivo reformulado en una o dos frases",
  "complexity": { "level": 1 | 2 | 3, "justification": "por qué" },
  "acceptanceCriteria": ["criterio verificable", "..."],
  "subtasks": [
    {
      "id": "s1",
      "title": "título breve",
      "description": "qué debe hacer el agente",
      "agentId": "id de un agente de la lista",
      "dependsOn": ["ids de subtareas previas necesarias"],
      "expectedOutput": "qué debe entregar"
    }
  ],
  "reviewStrategy": "cómo se revisará el resultado",
  "completionConditions": ["condición para dar la tarea por terminada"],
  "assumptions": ["supuestos explícitos"],
  "questions": ["preguntas solo si falta un dato esencial"]
}
Reglas:
- Niveles: 1 = sencillo (un agente basta), 2 = intermedio, 3 = complejo o crítico.
- Usa como máximo 8 subtareas y solo los agentes necesarios. Una tarea sencilla puede tener una sola subtarea.
- "agentId" debe ser uno de los identificadores de la lista de agentes disponibles.
- "dependsOn" solo puede contener ids de otras subtareas del plan, sin ciclos.
- La revisión crítica y la síntesis final las hace el sistema después: no las incluyas como subtareas.
- Si los criterios del usuario son útiles, inclúyelos; añade los que falten para que sean verificables.
- Escribe en español.`;

export class PlanningService {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly repo: Repository,
    private readonly tasks: TaskRepository,
    private readonly providers: ProviderRegistry,
    private readonly timeoutMs: number,
    private readonly costs: CostPolicy,
  ) {}

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /**
   * Comprueba todo lo necesario y lanza la planificación en segundo plano.
   * El progreso se consulta con el detalle de la tarea.
   */
  async start(taskId: string, input: PlanTaskInput): Promise<void> {
    const task = this.tasks.getTask(taskId);
    if (!task) throw taskNotFound();
    if (this.active.has(taskId) || task.status === 'planning') {
      throw new HttpError(409, 'invalid_request', 'La tarea ya se está planificando.', 'Espera a que termine o cancélala.');
    }
    if (task.status === 'cancelled') {
      throw new HttpError(409, 'invalid_request', 'La tarea está cancelada.', 'Crea una tarea nueva.');
    }
    if (task.status === 'running') {
      throw new HttpError(409, 'invalid_request', 'La tarea se está ejecutando.', 'Espera a que termine o detenla.');
    }
    if (input.feedback && !this.tasks.currentPlan(taskId)) {
      throw new HttpError(400, 'invalid_request', 'No hay un plan previo que corregir.', 'Genera primero un plan.');
    }
    const coordinator = this.repo.getAgent(COORDINATOR_ID);
    if (!coordinator?.enabled) {
      throw new HttpError(409, 'policy', 'El agente Coordinador está deshabilitado.', 'Habilítalo en Agentes para planificar tareas.');
    }
    const provider = requireUsableProvider(this.providers, this.repo, input.providerId);

    const controller = new AbortController();
    this.active.set(taskId, controller);
    try {
      this.costs.checkModel(await this.costs.resolveModel(provider, input.modelId), this.costs.modeFor(task));
    } catch (err) {
      this.active.delete(taskId);
      throw err;
    }
    this.tasks.setTaskStatus(taskId, 'planning');
    void this.run(task, input, provider, coordinator, controller).finally(() => this.active.delete(taskId));
  }

  /** Cancela la planificación en curso. Las llamadas ya hechas quedan registradas. */
  cancel(taskId: string): boolean {
    const controller = this.active.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Espera a que termine la planificación en curso (para pruebas y apagado ordenado). */
  async idle(): Promise<void> {
    while (this.active.size) await new Promise((r) => setTimeout(r, 5));
  }

  private async run(
    task: Task,
    input: PlanTaskInput,
    provider: ProviderAdapter,
    coordinator: Agent,
    controller: AbortController,
  ): Promise<void> {
    const runIds: string[] = [];
    const previous = this.tasks.currentPlan(task.id);
    // Si falla una nueva versión, el plan vigente (propuesto o aprobado) sigue disponible.
    const fallbackStatus: Task['status'] =
      previous?.status === 'approved' ? 'approved' : previous?.status === 'proposed' ? 'plan_ready' : 'plan_failed';
    try {
      const agents = this.repo.listAgents().filter((a) => a.enabled && !STAGE_ROLES.has(a.role));
      const rule = estimateComplexity(task);
      const messages: ChatTurn[] = [
        { role: 'system', content: `${systemPrompt(coordinator)}\n\n${PLAN_FORMAT}` },
        { role: 'user', content: taskData(task, agents, rule, previous, input.feedback) },
      ];

      let errors: string[] = [];
      let raw = '';
      for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          // Corrección: se envía la respuesta inválida (si hubo texto) y los errores concretos.
          if (raw.trim()) messages.push({ role: 'assistant', content: raw });
          messages.push({
            role: 'user',
            content: raw.trim()
              ? `Tu respuesta no es un plan válido. Errores:\n- ${errors.join('\n- ')}\n\nDevuelve SOLO el objeto JSON corregido.`
              : 'No entregaste ninguna respuesta. Devuelve SOLO el objeto JSON del plan, sin razonamiento previo.',
          });
        }
        const response = await recordedCall(
          { repo: this.repo, tasks: this.tasks, timeoutMs: this.timeoutMs },
          {
            run: {
              taskId: task.id,
              agentId: coordinator.id,
              kind: attempt === 1 ? 'plan' : 'plan_repair',
              providerId: provider.id,
              modelId: input.modelId,
            },
            provider,
            messages,
            maxOutputTokens: coordinator.maxOutputTokens ?? PLAN_MAX_OUTPUT_TOKENS,
            temperature: coordinator.temperature ?? PLAN_TEMPERATURE,
            responseFormat: 'json',
            signal: controller.signal,
            // También las llamadas fallidas quedan asociadas a esta planificación.
            onStart: (run) => runIds.push(run.id),
            cost: { policy: this.costs, mode: this.costs.modeFor(task), task },
          },
        );
        raw = response.text;

        const result: ReturnType<typeof parsePlan> = raw.trim()
          ? parsePlan(
              raw,
              agents.map((a) => a.id),
            )
          : { ok: false, errors: [emptyResponseError(response.finishReason, 'el plan')] };
        if (result.ok) {
          const level = task.complexityOverride ?? result.content.complexity.level;
          const plan = this.tasks.addPlan({
            taskId: task.id,
            status: 'proposed',
            content: result.content,
            rawOutput: raw,
            validationErrors: [],
            ruleComplexity: rule.level,
            limits: executionLimits(level, result.content.subtasks.length, task.reviewLevel),
            feedback: input.feedback ?? null,
            providerId: provider.id,
            modelId: input.modelId,
          });
          this.tasks.linkRunsToPlan(runIds, plan.id);
          this.tasks.setTaskStatus(task.id, 'plan_ready');
          return;
        }
        errors = result.errors;
        log.warn(`Plan no válido (intento ${attempt}) para la tarea ${task.id}: ${errors.join(' | ')}`);
      }

      const plan = this.tasks.addPlan({
        taskId: task.id,
        status: 'invalid',
        content: null,
        rawOutput: raw,
        validationErrors: errors,
        ruleComplexity: rule.level,
        limits: null,
        feedback: input.feedback ?? null,
        providerId: provider.id,
        modelId: input.modelId,
      });
      this.tasks.linkRunsToPlan(runIds, plan.id);
      this.tasks.setTaskStatus(task.id, fallbackStatus, {
        kind: 'invalid_request',
        message: `El Coordinador no produjo un plan válido tras ${MAX_PLAN_ATTEMPTS} intentos. Prueba con otro modelo.`,
      });
    } catch (err) {
      const e = err instanceof ProviderError ? err : null;
      if (e?.kind === 'cancelled') {
        // Si se canceló la tarea entera, se respeta ese estado.
        if (this.tasks.getTask(task.id)?.status === 'planning') {
          this.tasks.setTaskStatus(task.id, previous ? fallbackStatus : 'draft');
        }
        return;
      }
      if (!e) log.error('Error interno al planificar.', err);
      this.tasks.setTaskStatus(task.id, fallbackStatus, {
        kind: e?.kind ?? 'unknown',
        message: e ? `${e.message} ${e.action}` : 'Error interno al planificar. Revisa el registro del servidor.',
      });
    }
  }

}

/**
 * Datos de la tarea para el Coordinador. Van en el mensaje del usuario,
 * separados de las instrucciones del agente.
 */
function taskData(
  task: Task,
  agents: Agent[],
  rule: { level: number; reasons: string[] },
  previous: Plan | null,
  feedback: string | undefined,
): string {
  const lines: (string | null)[] = [
    '## Tarea',
    `Objetivo: ${task.objective}`,
    task.context ? `Contexto:\n${task.context}` : 'Contexto: (no indicado)',
    task.acceptanceCriteria ? `Criterios de aceptación del usuario:\n${task.acceptanceCriteria}` : 'Criterios de aceptación del usuario: (no indicados)',
    `Nivel de revisión pedido: ${{ none: 'sin revisión', standard: 'estándar', strict: 'estricta' }[task.reviewLevel]}`,
    `Estimación de complejidad por reglas: nivel ${rule.level} (${rule.reasons.join(' ')})`,
    task.complexityOverride ? `El usuario fijó el nivel de complejidad en ${task.complexityOverride}.` : null,
    '',
    '## Agentes disponibles para subtareas',
    ...agents.map(
      (a) => `- ${a.id}: ${a.name} (${a.role})${a.specialty ? `, especialidad: ${a.specialty}` : ''}. ${a.description}`,
    ),
  ];
  if (feedback && previous?.content) {
    lines.push(
      '',
      '## Plan anterior',
      JSON.stringify(previous.content),
      '',
      '## Cambios que pide el usuario',
      feedback,
      'Devuelve el plan completo corregido.',
    );
  }
  return lines.filter((l): l is string => l !== null).join('\n');
}

function taskNotFound() {
  return new HttpError(404, 'invalid_request', 'La tarea no existe.', 'Vuelve a la lista de tareas.');
}
