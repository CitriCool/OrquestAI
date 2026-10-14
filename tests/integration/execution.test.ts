import { describe, expect, it } from 'vitest';
import type { PlanContent, Task, TaskDetail } from '../../src/shared/schemas.js';
import { createTestApp, fakeProvider, modelList } from '../fixtures/helpers.js';

type Request = ReturnType<typeof createTestApp>['request'];

const MOCK = { providerId: 'simulado', modelId: 'simulado-basico' };

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function waitIdle(request: Request, id: string): Promise<TaskDetail> {
  for (let i = 0; i < 400; i++) {
    const r = await json<{ task: TaskDetail; planning: boolean; executing: boolean }>(await request('GET', `/tasks/${id}`));
    if (!r.planning && !r.executing && !['planning', 'running'].includes(r.task.status)) return r.task;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('La tarea no terminó');
}

/** Crea una tarea, la planifica con el simulado y aprueba el plan. */
async function approvedTask(request: Request, body: object = {}, planWith: object = MOCK): Promise<Task> {
  const created = await json<{ task: Task }>(
    await request('POST', '/tasks', { objective: 'Implementar un respaldo', ...body }),
  );
  const id = created.task.id;
  expect((await request('POST', `/tasks/${id}/plan`, planWith)).status).toBe(202);
  const planned = await waitIdle(request, id);
  expect(planned.status).toBe('plan_ready');
  const approved = await request('POST', `/tasks/${id}/approve`, { planId: planned.plans.at(-1)!.id });
  expect(approved.status).toBe(200);
  return created.task;
}

async function execute(request: Request, id: string, body: object = MOCK): Promise<TaskDetail> {
  const res = await request('POST', `/tasks/${id}/execute`, body);
  expect(res.status).toBe(202);
  return waitIdle(request, id);
}

const kinds = (t: TaskDetail) => t.runs.filter((r) => r.execution !== null).map((r) => `${r.kind}:${r.subtaskId ?? r.round ?? ''}`);

describe('ejecución de tareas', () => {
  it('ejecuta las subtareas en orden, revisa, sintetiza y guarda cada resultado', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request);
    const done = await execute(request, task.id);

    expect(done.status).toBe('completed');
    expect(done.outcome).toBe('complete');
    expect(done.limitations).toEqual([]);
    expect(kinds(done)).toEqual(['subtask:s1', 'subtask:s2', 'review:1', 'synthesis:']);
    const runs = done.runs.filter((r) => r.execution === 1);
    expect(runs.every((r) => r.status === 'complete' && r.output)).toBe(true);
    expect(runs.find((r) => r.kind === 'review')!.review).toMatchObject({ verdict: 'aprobado' });
    expect(runs.map((r) => r.agentId)).toEqual(['arquitecto', 'desarrollador', 'revisor', 'sintetizador']);
    expect(done.result).toBeTruthy();

    // Aceptar el resultado cierra la tarea.
    const accepted = await json<{ task: TaskDetail }>(await request('POST', `/tasks/${task.id}/accept`));
    expect(accepted.task.status).toBe('done');
  });

  it('corrige con el agente original cuando la revisión encuentra un problema importante', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request, { context: '/revision cambios' });
    const done = await execute(request, task.id);
    expect(kinds(done)).toEqual(['subtask:s1', 'subtask:s2', 'review:1', 'correction:s2', 'review:2', 'synthesis:']);
    const correction = done.runs.find((r) => r.kind === 'correction')!;
    expect(correction).toMatchObject({ agentId: 'desarrollador', round: 2 });
    const lastReview = done.runs.filter((r) => r.kind === 'review').at(-1)!.review!;
    expect(lastReview.observations[0]).toMatchObject({ id: 'o1', status: 'corregido' });
    expect(done.outcome).toBe('complete');
  });

  it('se detiene si el revisor repite las mismas observaciones y entrega un resultado parcial', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request, { context: '/revision repetida', complexityOverride: 3 });
    const done = await execute(request, task.id);
    expect(done.status).toBe('completed');
    expect(done.outcome).toBe('partial');
    expect(done.limitations.join(' ')).toMatch(/repitió las mismas observaciones/);
    expect(done.limitations.join(' ')).toMatch(/sin resolver/);
    expect(kinds(done).filter((k) => k.startsWith('review')).length).toBe(2);
  });

  it('con revisión estándar no corrige observaciones medias, pero el resultado queda parcial y lo explica', async () => {
    const { request } = createTestApp();
    const standard = await approvedTask(request, { context: '/revision menor' });
    const done = await execute(request, standard.id);
    expect(kinds(done)).toEqual(['subtask:s1', 'subtask:s2', 'review:1', 'synthesis:']);
    expect(done.outcome).toBe('partial');
    expect(done.limitations.join(' ')).toMatch(/gravedad media.*revisión estándar/);

    // Con revisión estricta, la observación media sí se corrige.
    const strict = await approvedTask(request, { context: '/revision menor', reviewLevel: 'strict' });
    const fixed = await execute(request, strict.id);
    expect(kinds(fixed)).toEqual(['subtask:s1', 'subtask:s2', 'review:1', 'correction:s2', 'review:2', 'synthesis:']);
    expect(fixed.outcome).toBe('complete');
  });

  it('respeta el límite de rondas', async () => {
    const { request } = createTestApp();
    // Nivel 1 → 1 ronda: no hay corrección aunque la revisión pida cambios.
    const task = await approvedTask(request, { context: '/revision cambios', complexityOverride: 1 });
    const done = await execute(request, task.id);
    expect(kinds(done)).toEqual(['subtask:s1', 'subtask:s2', 'review:1', 'synthesis:']);
    expect(done.outcome).toBe('partial');
    expect(done.limitations.join(' ')).toMatch(/máximo de 1 ronda/);
  });

  it('una revisión sin formato válido se corrige una vez y, si sigue mal, queda como limitación', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request, { context: '/revision invalida', complexityOverride: 3 });
    const done = await execute(request, task.id);
    expect(kinds(done)).toEqual(['subtask:s1', 'subtask:s2', 'review:1', 'review_repair:1', 'synthesis:']);
    expect(done.outcome).toBe('partial');
    expect(done.limitations.join(' ')).toMatch(/no tuvo un formato válido/);
  });

  it('sin revisión: ejecuta y sintetiza, y lo declara como limitación', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request, { reviewLevel: 'none' });
    const done = await execute(request, task.id);
    expect(kinds(done)).toEqual(['subtask:s1', 'subtask:s2', 'synthesis:']);
    expect(done.limitations.join(' ')).toMatch(/sin revisión/);
  });

  it('un fallo del proveedor deja la tarea fallida con el error y los resultados previos guardados', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request, { context: '/ejecucion error' });
    const done = await execute(request, task.id);
    expect(done.status).toBe('failed');
    expect(done.errorKind).toBe('server');
    expect(done.runs.filter((r) => r.execution === 1)[0]).toMatchObject({ status: 'error', kind: 'subtask' });
  });

  it('si la revisión o la síntesis fallan, conserva las entregas y devuelve un resultado parcial', async () => {
    const provider = fakeProvider((url, init) => {
      if (url.endsWith('/models')) return modelList();
      const system = (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages[0]!.content;
      if (system.includes('PLANIFICAR')) {
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  interpretedObjective: 'O',
                  complexity: { level: 2, justification: 'x' },
                  acceptanceCriteria: ['c'],
                  subtasks: [
                    { id: 'a', title: 'A', description: 'A', agentId: 'arquitecto', dependsOn: [], expectedOutput: 'A' },
                    { id: 'b', title: 'B', description: 'B', agentId: 'desarrollador', dependsOn: ['a'], expectedOutput: 'B' },
                  ],
                  reviewStrategy: 'x',
                  completionConditions: ['x'],
                }),
              },
            },
          ],
        });
      }
      if (system.includes('"verdict"') || system.includes('## Solución final')) return new Response('falla', { status: 500 });
      return Response.json({ choices: [{ message: { content: 'Entrega' } }] });
    });
    const { request } = createTestApp({ extraProviders: [provider] });
    await request('POST', '/providers/falso/consent', { accepted: true });
    const falso = { providerId: 'falso', modelId: 'gratis/modelo:free' };
    const task = await approvedTask(request, {}, falso);
    const done = await execute(request, task.id, falso);
    expect(done.status).toBe('completed');
    expect(done.outcome).toBe('partial');
    expect(done.limitations.join(' ')).toMatch(/revisión de la ronda 1 falló/);
    expect(done.limitations.join(' ')).toMatch(/síntesis falló/);
    expect(done.result).toContain('Entrega');
    expect(kinds(done)).toEqual(['subtask:a', 'subtask:b', 'review:1', 'synthesis:']);
  });

  it('detener la ejecución la deja interrumpida y se puede volver a ejecutar (nueva ejecución)', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request, { context: '/ejecucion lenta' });
    expect((await request('POST', `/tasks/${task.id}/execute`, MOCK)).status).toBe(202);
    expect((await request('POST', `/tasks/${task.id}/execute`, MOCK)).status).toBe(409);
    expect((await request('POST', `/tasks/${task.id}/plan`, MOCK)).status).toBe(409);
    await new Promise((r) => setTimeout(r, 20));
    expect((await json<{ stopped: boolean }>(await request('POST', `/tasks/${task.id}/stop`))).stopped).toBe(true);
    const stopped = await waitIdle(request, task.id);
    expect(stopped.status).toBe('interrupted');
    expect(stopped.runs.find((r) => r.execution === 1)).toMatchObject({ status: 'cancelled' });
  });

  it('sin plan aprobado no se ejecuta', async () => {
    const { request } = createTestApp();
    const created = await json<{ task: Task }>(await request('POST', '/tasks', { objective: 'x' }));
    expect((await request('POST', `/tasks/${created.task.id}/execute`, MOCK)).status).toBe(409);
    expect((await request('POST', `/tasks/${created.task.id}/accept`)).status).toBe(409);
  });

  it('no empieza si un agente del plan está deshabilitado', async () => {
    const { request } = createTestApp();
    const task = await approvedTask(request);
    await request('PATCH', '/agents/revisor', { enabled: false });
    const res = await request('POST', `/tasks/${task.id}/execute`, MOCK);
    expect(res.status).toBe(409);
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(/revisor/);
  });

  it('declara como limitación una entrega cortada y pide una revisión más breve si se corta', async () => {
    const requests: { system: string; last: string }[] = [];
    let reviews = 0;
    const plan: PlanContent = {
      interpretedObjective: 'Objetivo',
      complexity: { level: 2, justification: 'x' },
      acceptanceCriteria: ['Funciona'],
      subtasks: [{ id: 'a', title: 'Única', description: 'Hacer A', agentId: 'desarrollador', dependsOn: [], expectedOutput: 'A' }],
      reviewStrategy: 'x',
      completionConditions: ['x'],
      assumptions: [],
      questions: [],
    };
    const provider = fakeProvider((url, init) => {
      if (url.endsWith('/models')) return modelList();
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      const system = body.messages[0]!.content;
      requests.push({ system, last: body.messages.at(-1)!.content });
      if (system.includes('PLANIFICAR')) return Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] });
      if (system.includes('"verdict"')) {
        reviews++;
        const content = reviews === 1 ? '{"verdict":"aprobado","summary":"cortado' : JSON.stringify({ verdict: 'aprobado', summary: 'Bien', criteria: [], observations: [] });
        return Response.json({ choices: [{ message: { content }, finish_reason: reviews === 1 ? 'length' : 'stop' }] });
      }
      return Response.json({ choices: [{ message: { content: 'Entrega a medias' }, finish_reason: 'length' }] });
    });
    const { request } = createTestApp({ extraProviders: [provider] });
    await request('POST', '/providers/falso/consent', { accepted: true });
    const falso = { providerId: 'falso', modelId: 'gratis/modelo:free' };
    const task = await approvedTask(request, {}, falso);
    const done = await execute(request, task.id, falso);

    expect(done.status).toBe('completed');
    expect(done.outcome).toBe('partial');
    expect(done.limitations.join(' ')).toMatch(/subtarea «a» se cortó/);
    expect(kinds(done)).toEqual(['subtask:a', 'review:1', 'review_repair:1']);
    const repair = requests.at(-1)!;
    expect(repair.last).toMatch(/MÁS BREVE/);
  });

  it('cada agente recibe solo su encargo y los resultados de sus dependencias, y usa su modelo preferido', async () => {
    const bodies: { model: string; messages: { role: string; content: string }[] }[] = [];
    const plan: PlanContent = {
      interpretedObjective: 'Objetivo',
      complexity: { level: 1, justification: 'x' },
      acceptanceCriteria: ['Funciona'],
      subtasks: [
        { id: 'a', title: 'Primera', description: 'Hacer A', agentId: 'arquitecto', dependsOn: [], expectedOutput: 'A' },
        { id: 'b', title: 'Independiente', description: 'Hacer B', agentId: 'tutor', dependsOn: [], expectedOutput: 'B' },
        { id: 'c', title: 'Final', description: 'Hacer C', agentId: 'desarrollador', dependsOn: ['a'], expectedOutput: 'C' },
      ],
      reviewStrategy: 'x',
      completionConditions: ['x'],
      assumptions: [],
      questions: [],
    };
    const provider = fakeProvider((url, init) => {
      if (url.endsWith('/models')) return modelList();
      const body = JSON.parse(String(init.body)) as (typeof bodies)[number];
      bodies.push(body);
      const system = body.messages[0]!.content;
      const content = system.includes('PLANIFICAR')
        ? JSON.stringify(plan)
        : system.includes('"verdict"')
          ? JSON.stringify({ verdict: 'aprobado', summary: 'Bien', criteria: [], observations: [] })
          : `ENTREGA-${bodies.length}`;
      return Response.json({ choices: [{ message: { content } }] });
    });
    const { request } = createTestApp({ extraProviders: [provider] });
    await request('POST', '/providers/falso/consent', { accepted: true });
    await request('PATCH', '/agents/tutor', MOCK); // el Tutor usa su modelo preferido (simulado)
    const falso = { providerId: 'falso', modelId: 'gratis/modelo:free' };
    const task = await approvedTask(request, {}, falso);
    const done = await execute(request, task.id, falso);
    expect(done.status).toBe('completed');

    const execBodies = bodies.slice(1); // la primera es la planificación
    const subtaskC = execBodies.find((b) => b.messages.at(-1)!.content.includes('Hacer C'))!;
    expect(subtaskC.messages.at(-1)!.content).toContain('subtarea previa «a»');
    expect(subtaskC.messages.at(-1)!.content).not.toContain('subtarea previa «b»');
    // El Tutor no pasó por el proveedor falso: usó el simulado.
    expect(execBodies.some((b) => b.messages.at(-1)!.content.includes('Hacer B'))).toBe(false);
    expect(done.runs.find((r) => r.subtaskId === 'b')).toMatchObject({ providerId: 'simulado', status: 'complete' });
  });
});
