import { randomUUID } from 'node:crypto';
import type {
  ComplexityLevel,
  CreateTaskInput,
  ErrorKind,
  ExecutionLimits,
  Plan,
  PlanContent,
  Task,
  TaskDetail,
  TaskRun,
  Usage,
} from '../../shared/schemas.js';
import { redact } from '../security/redact.js';
import type { DB } from './db.js';

interface TaskRow {
  id: string;
  title: string;
  objective: string;
  context: string;
  acceptance_criteria: string;
  review_level: Task['reviewLevel'];
  complexity_override: ComplexityLevel | null;
  status: Task['status'];
  error_kind: ErrorKind | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  task_id: string;
  version: number;
  status: Plan['status'];
  content: string | null;
  raw_output: string | null;
  validation_errors: string;
  rule_complexity: ComplexityLevel;
  limits: string | null;
  feedback: string | null;
  provider_id: string;
  model_id: string;
  created_at: string;
  approved_at: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  plan_id: string | null;
  agent_id: string | null;
  kind: TaskRun['kind'];
  provider_id: string;
  model_id: string;
  status: TaskRun['status'];
  error_kind: ErrorKind | null;
  error_message: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
  cost_kind: Usage['costKind'] | null;
  started_at: string;
  finished_at: string | null;
}

const now = () => new Date().toISOString();

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    objective: r.objective,
    context: r.context,
    acceptanceCriteria: r.acceptance_criteria,
    reviewLevel: r.review_level,
    complexityOverride: r.complexity_override,
    status: r.status,
    errorKind: r.error_kind,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    taskId: r.task_id,
    version: r.version,
    status: r.status,
    content: r.content ? (JSON.parse(r.content) as PlanContent) : null,
    validationErrors: JSON.parse(r.validation_errors) as string[],
    ruleComplexity: r.rule_complexity,
    limits: r.limits ? (JSON.parse(r.limits) as ExecutionLimits) : null,
    feedback: r.feedback,
    providerId: r.provider_id,
    modelId: r.model_id,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
  };
}

function toRun(r: RunRow): TaskRun {
  return {
    id: r.id,
    taskId: r.task_id,
    planId: r.plan_id,
    agentId: r.agent_id,
    kind: r.kind,
    providerId: r.provider_id,
    modelId: r.model_id,
    status: r.status,
    errorKind: r.error_kind,
    errorMessage: r.error_message,
    usage: r.cost_kind
      ? { promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, cost: r.cost, costKind: r.cost_kind }
      : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** Persistencia de tareas, versiones del plan y llamadas a modelos. */
export class TaskRepository {
  constructor(readonly db: DB) {}

  listTasks(): Task[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as TaskRow[]).map(toTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  getTaskDetail(id: string): TaskDetail | null {
    const task = this.getTask(id);
    if (!task) return null;
    const plans = (
      this.db.prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY version ASC').all(id) as PlanRow[]
    ).map(toPlan);
    const runs = (
      this.db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC, rowid ASC').all(id) as RunRow[]
    ).map(toRun);
    return { ...task, plans, runs };
  }

  createTask(input: CreateTaskInput & { title: string }): Task {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, objective, context, acceptance_criteria, review_level, complexity_override,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.objective,
        input.context,
        input.acceptanceCriteria,
        input.reviewLevel,
        input.complexityOverride,
        ts,
        ts,
      );
    return this.getTask(id)!;
  }

  updateTask(id: string, input: { title?: string; complexityOverride?: ComplexityLevel | null }): Task | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.title !== undefined) {
      sets.push('title = ?');
      values.push(input.title);
    }
    if (input.complexityOverride !== undefined) {
      sets.push('complexity_override = ?');
      values.push(input.complexityOverride);
    }
    if (sets.length === 0) return this.getTask(id);
    const res = this.db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
    return res.changes ? this.getTask(id) : null;
  }

  setTaskStatus(id: string, status: Task['status'], error: { kind: ErrorKind; message: string } | null = null): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, error_kind = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .run(status, error?.kind ?? null, error ? redact(error.message) : null, now(), id);
  }

  deleteTask(id: string): boolean {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
  }

  // ---- Planes ----

  getPlan(id: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    return row ? toPlan(row) : null;
  }

  latestPlan(taskId: string): Plan | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY version DESC LIMIT 1')
      .get(taskId) as PlanRow | undefined;
    return row ? toPlan(row) : null;
  }

  /** Plan vigente: el último propuesto o aprobado (los inválidos no cuentan). */
  currentPlan(taskId: string): Plan | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plans WHERE task_id = ? AND status IN ('proposed', 'approved') ORDER BY version DESC LIMIT 1`,
      )
      .get(taskId) as PlanRow | undefined;
    return row ? toPlan(row) : null;
  }

  /**
   * Guarda una versión nueva del plan. Una versión válida sustituye al plan
   * vigente; una inválida se guarda para consulta sin sustituir nada.
   */
  addPlan(input: {
    taskId: string;
    status: 'proposed' | 'invalid';
    content: PlanContent | null;
    rawOutput: string | null;
    validationErrors: string[];
    ruleComplexity: ComplexityLevel;
    limits: ExecutionLimits | null;
    feedback: string | null;
    providerId: string;
    modelId: string;
  }): Plan {
    const id = randomUUID();
    this.db.transaction(() => {
      if (input.status === 'proposed') {
        this.db
          .prepare(`UPDATE plans SET status = 'superseded' WHERE task_id = ? AND status IN ('proposed', 'approved')`)
          .run(input.taskId);
      }
      const next = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM plans WHERE task_id = ?')
        .get(input.taskId) as { v: number };
      this.db
        .prepare(
          `INSERT INTO plans (id, task_id, version, status, content, raw_output, validation_errors, rule_complexity,
             limits, feedback, provider_id, model_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          next.v,
          input.status,
          input.content ? JSON.stringify(input.content) : null,
          input.rawOutput,
          JSON.stringify(input.validationErrors),
          input.ruleComplexity,
          input.limits ? JSON.stringify(input.limits) : null,
          input.feedback,
          input.providerId,
          input.modelId,
          now(),
        );
    })();
    return this.getPlan(id)!;
  }

  updatePlanLimits(planId: string, limits: ExecutionLimits): void {
    this.db.prepare('UPDATE plans SET limits = ? WHERE id = ?').run(JSON.stringify(limits), planId);
  }

  approvePlan(planId: string): Plan {
    this.db.prepare(`UPDATE plans SET status = 'approved', approved_at = ? WHERE id = ?`).run(now(), planId);
    return this.getPlan(planId)!;
  }

  // ---- Llamadas ----

  startRun(input: {
    taskId: string;
    agentId: string | null;
    kind: TaskRun['kind'];
    providerId: string;
    modelId: string;
  }): TaskRun {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO task_runs (id, task_id, agent_id, kind, provider_id, model_id, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, input.taskId, input.agentId, input.kind, input.providerId, input.modelId, now());
    return this.getRun(id)!;
  }

  finishRun(
    id: string,
    result: {
      status: Exclude<TaskRun['status'], 'running'>;
      usage?: Usage | null;
      errorKind?: ErrorKind | null;
      errorMessage?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE task_runs SET status = ?, prompt_tokens = ?, completion_tokens = ?, cost = ?, cost_kind = ?,
           error_kind = ?, error_message = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        result.status,
        result.usage?.promptTokens ?? null,
        result.usage?.completionTokens ?? null,
        result.usage?.cost ?? null,
        result.usage?.costKind ?? null,
        result.errorKind ?? null,
        result.errorMessage ? redact(result.errorMessage) : null,
        now(),
        id,
      );
  }

  /** Asocia las llamadas que produjeron un plan con esa versión. */
  linkRunsToPlan(runIds: string[], planId: string): void {
    const stmt = this.db.prepare('UPDATE task_runs SET plan_id = ? WHERE id = ?');
    this.db.transaction(() => runIds.forEach((r) => stmt.run(planId, r)))();
  }

  getRun(id: string): TaskRun | null {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /**
   * Tareas que quedaron planificando porque la aplicación se cerró: vuelven
   * a su plan vigente si lo tienen (o a «plan_failed») y sus llamadas en
   * curso pasan a «cancelled».
   */
  recoverInterruptedTasks(): number {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE task_runs SET status = 'cancelled', error_kind = 'cancelled',
             error_message = 'La llamada se interrumpió porque la aplicación se cerró.', finished_at = ?
           WHERE status = 'running'`,
        )
        .run(now());
      return this.db
        .prepare(
          `UPDATE tasks SET
             status = COALESCE(
               (SELECT CASE p.status WHEN 'approved' THEN 'approved' ELSE 'plan_ready' END
                FROM plans p WHERE p.task_id = tasks.id AND p.status IN ('proposed', 'approved')
                ORDER BY p.version DESC LIMIT 1),
               'plan_failed'),
             error_kind = 'cancelled',
             error_message = 'La planificación se interrumpió porque la aplicación se cerró.', updated_at = ?
           WHERE status = 'planning'`,
        )
        .run(now()).changes;
    })();
  }
}
