import { describe, expect, it } from 'vitest';
import { classifyPricing, estimateCallCost } from '../../src/shared/pricing.js';
import type { ConversationDetail, CostSettings, ModelInfo, Spending, Task, TaskDetail } from '../../src/shared/schemas.js';
import { createTestApp, fakeProvider } from '../fixtures/helpers.js';

type Request = ReturnType<typeof createTestApp>['request'];
type CostsResponse = { settings: CostSettings; spending: { today: Spending; month: Spending } };

const M = 1 / 1_000_000;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function setCosts(request: Request, over: Partial<CostSettings>): Promise<CostsResponse> {
  const current = await json<CostsResponse>(await request('GET', '/settings/costs'));
  const res = await request('PUT', '/settings/costs', { ...current.settings, ...over });
  expect(res.status).toBe(200);
  return json<CostsResponse>(res);
}

async function chat(request: Request, modelId: string, content = 'Hola') {
  const c = await json<{ conversation: { id: string } }>(await request('POST', '/conversations', {}));
  const res = await request('POST', `/conversations/${c.conversation.id}/messages`, { providerId: 'simulado', modelId, content });
  const body = res.status === 200 ? await res.text() : await res.json();
  const detail = await json<{ conversation: ConversationDetail }>(await request('GET', `/conversations/${c.conversation.id}`));
  return { status: res.status, body, reply: detail.conversation.messages.find((m) => m.role === 'assistant') };
}

describe('precios', () => {
  it('clasifica por precio de salida y estima una cota superior', () => {
    expect(classifyPricing({ prompt: 0, completion: 0, request: 0 })).toBe('free');
    expect(classifyPricing({ prompt: 0, completion: 0, request: 0.001 })).toBe('low');
    expect(classifyPricing({ prompt: 0.5 * M, completion: 1.5 * M, request: 0 })).toBe('low');
    expect(classifyPricing({ prompt: 3 * M, completion: 10 * M, request: 0 })).toBe('standard');
    expect(classifyPricing({ prompt: 15 * M, completion: 60 * M, request: 0 })).toBe('premium');
    // 3.000 caracteres → 1.000 tokens de entrada (3 por token) + 1.000 de salida.
    expect(estimateCallCost({ prompt: 1 * M, completion: 2 * M, request: 0.01 }, 3_000, 1_000)).toBeCloseTo(0.013, 10);
  });

  it('lee el precio del listado (USD por token) y toma el mayor de los precios condicionales', async () => {
    const provider = fakeProvider(() =>
      Response.json({
        data: [
          {
            id: 'largo/contexto',
            name: 'Largo',
            pricing: { prompt: '0.000001', completion: '0.000004', overrides: [{ min_prompt_tokens: 200000, prompt: '0.000002' }] },
          },
          { id: 'gratis/pero-cobra', name: 'Cobra por solicitud', pricing: { prompt: '0', completion: '0', request: '0.002' } },
        ],
      }),
    );
    const models = await provider.listModels();
    const largo = models.find((m) => m.id === 'largo/contexto') as ModelInfo;
    expect(largo.pricing).toEqual({ prompt: 0.000002, completion: 0.000004, request: 0 });
    expect(largo.costClass).toBe('standard');
    // Precio de tokens 0 no basta: si cobra por solicitud, no es gratuito.
    expect(models.find((m) => m.id === 'gratis/pero-cobra')!.costClass).not.toBe('free');
  });
});

describe('modos de coste', () => {
  it('A · gratuito (por omisión): solo modelos gratuitos', async () => {
    const { request } = createTestApp();
    expect((await chat(request, 'simulado-basico')).status).toBe(200);
    const paid = await chat(request, 'simulado-economico');
    expect(paid.status).toBe(403);
    expect((paid.body as { error: { message: string } }).error.message).toMatch(/exclusivamente gratuito/);
  });

  it('B · económico: gratuitos y económicos; nada de coste medio, alto o desconocido', async () => {
    const { request } = createTestApp();
    await setCosts(request, { mode: 'economic' });
    expect((await chat(request, 'simulado-economico')).status).toBe(200);
    for (const id of ['simulado-pago', 'simulado-premium', 'simulado-sin-precio']) {
      expect((await chat(request, id)).status).toBe(403);
    }
  });

  it('C · manual: cualquier modelo con precio; coste desconocido solo si se permite', async () => {
    const { request } = createTestApp();
    await setCosts(request, { mode: 'manual' });
    expect((await chat(request, 'simulado-premium')).status).toBe(200);
    expect((await chat(request, 'simulado-sin-precio')).status).toBe(403);
    await setCosts(request, { allowUnknownCostInManual: true });
    const unknown = await chat(request, 'simulado-sin-precio');
    expect(unknown.status).toBe(200);
    expect(unknown.reply!.usage).toMatchObject({ cost: null, costKind: 'unknown' });
    const costs = await json<CostsResponse>(await request('GET', '/settings/costs'));
    expect(costs.spending.today.unknownCalls).toBe(1);
  });
});

describe('presupuestos y registro del consumo', () => {
  it('registra el coste reportado y lo suma al gasto del día y del mes', async () => {
    const { request } = createTestApp();
    await setCosts(request, { mode: 'manual' });
    const { reply } = await chat(request, 'simulado-pago');
    expect(reply!.usage!.costKind).toBe('reported');
    expect(reply!.usage!.cost).toBeGreaterThan(0);
    const costs = await json<CostsResponse>(await request('GET', '/settings/costs'));
    expect(costs.spending.today.spentUsd).toBeCloseTo(reply!.usage!.cost!, 12);
    expect(costs.spending.month.spentUsd).toBeCloseTo(reply!.usage!.cost!, 12);
    expect(costs.spending.today.estimatedUsd).toBe(0);
  });

  it('si el proveedor no informa el coste, registra una estimación marcada como tal', async () => {
    const { request } = createTestApp();
    await setCosts(request, { mode: 'manual' });
    const { reply } = await chat(request, 'simulado-pago', 'Hola /sin coste');
    expect(reply!.usage!.costKind).toBe('estimated');
    expect(reply!.usage!.cost).toBeGreaterThan(0);
    const costs = await json<CostsResponse>(await request('GET', '/settings/costs'));
    expect(costs.spending.today.estimatedUsd).toBeCloseTo(reply!.usage!.cost!, 12);
  });

  it('bloquea antes de llamar si la estimación máxima supera el presupuesto diario', async () => {
    const { request } = createTestApp();
    // Tope de salida del chat: 8.000 tokens × USD 10/M = USD 0,08 como mínimo.
    await setCosts(request, { mode: 'manual', dailyBudgetUsd: 0.05 });
    const blocked = await chat(request, 'simulado-pago');
    expect(blocked.status).toBe(403);
    expect((blocked.body as { error: { message: string } }).error.message).toMatch(/presupuesto diario no alcanza/);
    expect(blocked.reply).toBeUndefined(); // no se llegó a llamar
    // Un modelo gratuito no consume presupuesto.
    expect((await chat(request, 'simulado-basico')).status).toBe(200);
  });

  it('valida los ajustes de costes', async () => {
    const { request } = createTestApp();
    const current = await json<CostsResponse>(await request('GET', '/settings/costs'));
    expect(current.settings).toMatchObject({ mode: 'free', taskBudgetUsd: 0.5, dailyBudgetUsd: 1, monthlyBudgetUsd: 10 });
    expect((await request('PUT', '/settings/costs', { ...current.settings, dailyBudgetUsd: -1 })).status).toBe(400);
    expect((await request('PUT', '/settings/costs', { ...current.settings, mode: 'gratis' })).status).toBe(400);
  });
});

describe('costes en tareas', () => {
  async function waitIdle(request: Request, id: string): Promise<TaskDetail> {
    for (let i = 0; i < 400; i++) {
      const r = await json<{ task: TaskDetail; planning: boolean; executing: boolean }>(await request('GET', `/tasks/${id}`));
      if (!r.planning && !r.executing && !['planning', 'running'].includes(r.task.status)) return r.task;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error('no terminó');
  }

  it('la tarea puede fijar su propio modo; el modo global no permite planificar con un modelo de pago', async () => {
    const { request } = createTestApp();
    const paid = { providerId: 'simulado', modelId: 'simulado-pago' };
    const global = await json<{ task: Task }>(await request('POST', '/tasks', { objective: 'x' }));
    expect((await request('POST', `/tasks/${global.task.id}/plan`, paid)).status).toBe(403);

    const own = await json<{ task: Task }>(await request('POST', '/tasks', { objective: 'x', costMode: 'manual', budgetUsd: 1 }));
    expect((await request('POST', `/tasks/${own.task.id}/plan`, paid)).status).toBe(202);
    const planned = await waitIdle(request, own.task.id);
    expect(planned.status).toBe('plan_ready');
    expect(planned.effectiveCostMode).toBe('manual');
    expect(planned.spending.budgetUsd).toBe(1);
    expect(planned.spending.spentUsd).toBeGreaterThan(0);
  });

  it('si se agota el presupuesto de la tarea a mitad de camino, guarda lo obtenido y termina con resultado parcial', async () => {
    const { request } = createTestApp();
    // Planificar (tope 4.000 tokens × USD 10/M ≈ USD 0,04) cabe; una subtarea (6.000 × USD 10/M = USD 0,06) no.
    const created = await json<{ task: Task }>(
      await request('POST', '/tasks', { objective: 'x', costMode: 'manual', budgetUsd: 0.05 }),
    );
    const id = created.task.id;
    const paid = { providerId: 'simulado', modelId: 'simulado-pago' };
    await request('POST', `/tasks/${id}/plan`, paid);
    const planned = await waitIdle(request, id);
    await request('POST', `/tasks/${id}/approve`, { planId: planned.plans[0]!.id });
    expect((await request('POST', `/tasks/${id}/execute`, paid)).status).toBe(202);
    const done = await waitIdle(request, id);

    expect(done.status).toBe('completed');
    expect(done.outcome).toBe('partial');
    expect(done.limitations.join(' ')).toMatch(/política de costes.*presupuesto de la tarea no alcanza/);
    const blocked = done.runs.find((r) => r.execution === 1)!;
    expect(blocked).toMatchObject({ kind: 'subtask', status: 'error', errorKind: 'policy' });
    expect(done.spending.spentUsd).toBeLessThanOrEqual(0.05);
  });
});
