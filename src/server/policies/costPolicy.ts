import { randomUUID } from 'node:crypto';
import {
  costSettingsSchema,
  DEFAULT_COST_SETTINGS,
  type CostMode,
  type CostSettings,
  type ModelInfo,
  type Spending,
  type Task,
  type Usage,
} from '../../shared/schemas.js';
import { estimateCallCost, formatUsd } from '../../shared/pricing.js';
import { HttpError } from '../http.js';
import { ProviderError, type ChatTurn, type ProviderAdapter } from '../providers/types.js';
import type { Repository } from '../storage/repository.js';

const SETTINGS_KEY = 'costSettings';

export const MODE_LABELS: Record<CostMode, string> = {
  free: 'A · exclusivamente gratuito',
  economic: 'B · económico',
  manual: 'C · control manual',
};

/** Llamada bloqueada por la política de costes (presupuesto o modo). */
export class BudgetError extends ProviderError {
  constructor(message: string, action: string) {
    super('policy', message, action);
    this.name = 'BudgetError';
  }
}

export interface Reservation {
  id: string;
  model: ModelInfo;
  /** Cota superior estimada antes de llamar; null si el precio es desconocido. */
  estimate: number | null;
}

interface CostRow {
  cost: number | null;
  cost_kind: Usage['costKind'] | null;
}

/**
 * Política de costes. Se aplica en el servidor antes de cada llamada:
 * comprueba que el modo permita el modelo, estima el coste máximo y lo
 * compara con lo que queda de cada presupuesto (tarea, día y mes), contando
 * también las llamadas en curso. Después registra el coste reportado o, si
 * el proveedor no lo informa, una estimación marcada como tal.
 */
export class CostPolicy {
  /** Coste reservado por llamadas en curso, para que dos llamadas simultáneas no superen el presupuesto. */
  private readonly reserved = new Map<string, { amount: number; taskId: string | null }>();

  constructor(private readonly repo: Repository) {}

  settings(): CostSettings {
    const raw = this.repo.getSetting(SETTINGS_KEY);
    if (!raw) return DEFAULT_COST_SETTINGS;
    const parsed = costSettingsSchema.safeParse({ ...DEFAULT_COST_SETTINGS, ...(JSON.parse(raw) as object) });
    return parsed.success ? parsed.data : DEFAULT_COST_SETTINGS;
  }

  saveSettings(settings: CostSettings): void {
    this.repo.setSetting(SETTINGS_KEY, JSON.stringify(settings));
  }

  modeFor(task?: Pick<Task, 'costMode'> | null): CostMode {
    return task?.costMode ?? this.settings().mode;
  }

  // ---- Gasto ----

  private sum(rows: CostRow[], budgetUsd: number): Spending {
    let spentUsd = 0;
    let estimatedUsd = 0;
    let unknownCalls = 0;
    for (const r of rows) {
      if (r.cost === null) {
        if (r.cost_kind === 'unknown') unknownCalls++;
        continue;
      }
      spentUsd += r.cost;
      if (r.cost_kind === 'estimated') estimatedUsd += r.cost;
    }
    return { spentUsd, estimatedUsd, unknownCalls, budgetUsd };
  }

  /** Gasto desde una fecha: respuestas del chat y llamadas dentro de tareas. */
  private spentSince(since: string): CostRow[] {
    return this.repo.db
      .prepare(
        `SELECT cost, cost_kind FROM messages WHERE role = 'assistant' AND created_at >= ?
         UNION ALL
         SELECT cost, cost_kind FROM task_runs WHERE started_at >= ?`,
      )
      .all(since, since) as CostRow[];
  }

  today(): Spending {
    return this.sum(this.spentSince(startOfDay()), this.settings().dailyBudgetUsd);
  }

  month(): Spending {
    return this.sum(this.spentSince(startOfMonth()), this.settings().monthlyBudgetUsd);
  }

  taskBudget(task: Pick<Task, 'budgetUsd'>): number {
    return task.budgetUsd ?? this.settings().taskBudgetUsd;
  }

  taskSpending(task: Pick<Task, 'id' | 'budgetUsd'>): Spending {
    const rows = this.repo.db.prepare('SELECT cost, cost_kind FROM task_runs WHERE task_id = ?').all(task.id) as CostRow[];
    return this.sum(rows, this.taskBudget(task));
  }

  // ---- Autorización ----

  /**
   * ¿Permite el modo este modelo? No mira presupuestos. Lanza HttpError
   * (para responder antes de empezar) con el motivo.
   */
  checkModel(model: ModelInfo, mode: CostMode): void {
    const deny = (reason: string, action: string): never => {
      throw new HttpError(403, 'policy', `El modelo "${model.id}" ${reason}`, action);
    };
    if (model.restriction) deny(`no se puede usar desde esta aplicación: ${model.restriction}`, 'Elige otro modelo.');
    if (model.costClass === 'free') return;

    if (model.costClass === 'unknown' || !model.pricing) {
      if (mode === 'manual' && this.settings().allowUnknownCostInManual) return;
      deny(
        `no tiene un precio verificable, así que su gasto no se puede controlar (modo ${MODE_LABELS[mode]}).`,
        mode === 'manual'
          ? 'Elige un modelo con precio conocido o, bajo tu responsabilidad, permite el coste desconocido en Ajustes.'
          : 'Elige un modelo con precio conocido.',
      );
    }
    if (mode === 'free') {
      deny(
        'no es gratuito y el modo activo es A · exclusivamente gratuito.',
        'Elige un modelo gratuito o cambia el modo de coste en Ajustes (o en la tarea).',
      );
    }
    if (mode === 'economic') {
      // Los modelos de coste medio o alto solo entrarán mediante escalamiento autorizado (Sprint 3.2).
      if (model.costClass !== 'low') {
        deny(
          'no es de bajo coste: en el modo B · económico solo se usan directamente modelos gratuitos o económicos.',
          'Elige un modelo gratuito o económico, o usa el modo C · control manual.',
        );
      }
    }
  }

  /** Modelo del listado del proveedor (con su precio). */
  async resolveModel(provider: ProviderAdapter, modelId: string): Promise<ModelInfo> {
    let models: ModelInfo[];
    try {
      models = await provider.listModels();
    } catch (err) {
      const e = err instanceof ProviderError ? err : provider.classifyProviderError(err);
      throw new HttpError(
        502,
        e.kind,
        `No se pudo comprobar el coste del modelo: ${e.message}`,
        `${e.action} Sin esa comprobación no se envía la solicitud.`,
      );
    }
    const model = models.find((m) => m.id === modelId);
    if (!model) {
      throw new HttpError(
        400,
        'model_unavailable',
        `El modelo "${modelId}" no aparece en el listado de ${provider.label}.`,
        'Elige otro modelo en Modelos y proveedores.',
      );
    }
    return model;
  }

  /**
   * Antes de cada llamada: comprueba modo y presupuestos con la estimación
   * máxima y reserva ese importe. Lanza BudgetError si no cabe.
   */
  async reserve(input: {
    provider: ProviderAdapter;
    modelId: string;
    messages: ChatTurn[];
    maxOutputTokens: number;
    mode: CostMode;
    task?: Pick<Task, 'id' | 'budgetUsd'> | null;
  }): Promise<Reservation> {
    // Si el modelo no existe o no se puede leer el listado, el error es ese (no de política).
    const model = await this.resolveModel(input.provider, input.modelId);
    try {
      this.checkModel(model, input.mode);
    } catch (err) {
      if (err instanceof HttpError) throw new BudgetError(err.message, err.action);
      throw err;
    }

    const id = randomUUID();
    if (model.costClass === 'free' || !model.pricing) {
      this.reserved.set(id, { amount: 0, taskId: input.task?.id ?? null });
      return { id, model, estimate: model.costClass === 'free' ? 0 : null };
    }

    const chars = input.messages.reduce((n, m) => n + m.content.length, 0);
    const estimate = estimateCallCost(model.pricing, chars, input.maxOutputTokens);
    const pending = [...this.reserved.values()];
    const reservedAll = pending.reduce((n, r) => n + r.amount, 0);
    const checks: { label: string; spent: number; budget: number }[] = [
      { label: 'diario', spent: this.today().spentUsd + reservedAll, budget: this.settings().dailyBudgetUsd },
      { label: 'mensual', spent: this.month().spentUsd + reservedAll, budget: this.settings().monthlyBudgetUsd },
    ];
    if (input.task) {
      const reservedTask = pending.filter((r) => r.taskId === input.task!.id).reduce((n, r) => n + r.amount, 0);
      checks.unshift({
        label: 'de la tarea',
        spent: this.taskSpending(input.task).spentUsd + reservedTask,
        budget: this.taskBudget(input.task),
      });
    }
    for (const c of checks) {
      if (c.spent + estimate > c.budget) {
        throw new BudgetError(
          `La llamada a "${model.id}" podría costar hasta ${formatUsd(estimate)} y el presupuesto ${c.label} no alcanza ` +
            `(gastado ${formatUsd(c.spent)} de ${formatUsd(c.budget)}).`,
          'Sube el presupuesto en Ajustes (o en la tarea), espera al siguiente periodo o elige un modelo más barato.',
        );
      }
    }
    this.reserved.set(id, { amount: estimate, taskId: input.task?.id ?? null });
    return { id, model, estimate };
  }

  /**
   * Libera la reserva y devuelve el uso a registrar: el coste reportado por
   * el proveedor o, si no lo informó, una estimación marcada como tal.
   */
  settle(reservation: Reservation, usage: Usage | null): Usage | null {
    this.reserved.delete(reservation.id);
    const base: Usage = usage ?? { promptTokens: null, completionTokens: null, cost: null, costKind: 'unknown' };
    if (base.cost !== null && base.costKind === 'reported') return base;
    const p = reservation.model.pricing;
    if (reservation.model.costClass === 'free' && (!p || (p.prompt === 0 && p.completion === 0 && p.request === 0))) {
      return { ...base, cost: 0, costKind: 'estimated' };
    }
    if (!p) return { ...base, cost: null, costKind: 'unknown' };
    // Con tokens informados, la estimación es más ajustada que la cota previa.
    const cost =
      base.promptTokens !== null && base.completionTokens !== null
        ? p.prompt * base.promptTokens + p.completion * base.completionTokens + p.request
        : reservation.estimate;
    return { ...base, cost, costKind: 'estimated' };
  }

  /** Libera la reserva de una llamada que falló o se canceló. */
  release(reservation: Reservation): void {
    this.reserved.delete(reservation.id);
  }
}

function startOfDay(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
