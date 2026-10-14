import { describe, expect, it } from 'vitest';
import type { Agent, Conversation, ConversationDetail } from '../../src/shared/schemas.js';
import { chunk, createTestApp, fakeProvider, modelList, parseSse, sseResponse } from '../fixtures/helpers.js';

type Request = ReturnType<typeof createTestApp>['request'];

const MOCK = { providerId: 'simulado', modelId: 'simulado-basico' };

const newAgent = {
  name: 'Experto en redes',
  description: 'Redes y protocolos',
  role: 'specialist',
  specialty: 'Redes',
  instructions: 'Responde con foco en el modelo OSI.',
};

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createAgent(request: Request, body: object = newAgent): Promise<Agent> {
  const res = await request('POST', '/agents', body);
  expect(res.status).toBe(201);
  return (await json<{ agent: Agent }>(res)).agent;
}

describe('gestión de agentes', () => {
  it('lista los 7 agentes iniciales editables', async () => {
    const { request } = createTestApp();
    const { agents } = await json<{ agents: Agent[] }>(await request('GET', '/agents'));
    expect(agents.map((a) => a.role)).toEqual([
      'coordinator',
      'developer',
      'architect',
      'reviewer',
      'specialist',
      'tutor',
      'synthesizer',
    ]);
    expect(agents.every((a) => a.builtin && a.enabled && a.runs === 0)).toBe(true);
  });

  it('crea, edita y elimina un agente personalizado', async () => {
    const { request } = createTestApp();
    const a = await createAgent(request);
    expect(a).toMatchObject({ role: 'specialist', builtin: false, enabled: true, providerId: null });

    const patched = await request('PATCH', `/agents/${a.id}`, { temperature: 0.2, maxOutputTokens: 800, ...MOCK });
    expect(patched.status).toBe(200);
    expect((await json<{ agent: Agent }>(patched)).agent).toMatchObject({ temperature: 0.2, maxOutputTokens: 800, ...MOCK });

    expect((await request('DELETE', `/agents/${a.id}`)).status).toBe(200);
    expect((await request('GET', `/agents/${a.id}`)).status).toBe(404);
  });

  it('valida los datos del agente', async () => {
    const { request } = createTestApp();
    expect((await request('POST', '/agents', { ...newAgent, instructions: '' })).status).toBe(400);
    expect((await request('POST', '/agents', { ...newAgent, role: 'coordinator' })).status).toBe(400);
    expect((await request('POST', '/agents', { ...newAgent, temperature: 3 })).status).toBe(400);
    // Proveedor sin modelo, o proveedor inexistente.
    expect((await request('POST', '/agents', { ...newAgent, providerId: 'simulado' })).status).toBe(400);
    expect((await request('POST', '/agents', { ...newAgent, providerId: 'no-existe', modelId: 'x' })).status).toBe(400);
    expect((await request('PATCH', '/agents/tutor', { modelId: 'simulado-basico' })).status).toBe(400);
  });

  it('los agentes iniciales no se eliminan, pero se pueden restaurar', async () => {
    const { request } = createTestApp();
    expect((await request('DELETE', '/agents/revisor')).status).toBe(409);
    await request('PATCH', '/agents/revisor', { name: 'Revisor estricto', enabled: false });
    const reset = await json<{ agent: Agent }>(await request('POST', '/agents/revisor/reset'));
    expect(reset.agent).toMatchObject({ name: 'Revisor crítico', enabled: true });
    const custom = await createAgent(request);
    expect((await request('POST', `/agents/${custom.id}/reset`)).status).toBe(409);
  });
});

describe('chat con un agente', () => {
  it('envía las instrucciones del agente y sus límites al proveedor, y registra la ejecución', async () => {
    let sentBody: Record<string, unknown> | null = null;
    const provider = fakeProvider((url, init) => {
      if (url.endsWith('/models')) return modelList();
      sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return sseResponse([chunk('Capa 3.'), 'data: [DONE]\n\n']);
    });
    const { request } = createTestApp({ extraProviders: [provider] });
    await request('POST', '/providers/falso/consent', { accepted: true });
    const agent = await createAgent(request, { ...newAgent, temperature: 0.1, maxOutputTokens: 500 });

    const conv = await json<{ conversation: Conversation }>(await request('POST', '/conversations', { agentId: agent.id }));
    expect(conv.conversation.agentId).toBe(agent.id);

    const res = await request('POST', `/conversations/${conv.conversation.id}/messages`, {
      providerId: 'falso',
      modelId: 'gratis/modelo:free',
      content: '¿En qué capa está IP?',
    });
    const events = parseSse(await res.text());
    const end = events.find((e) => e.type === 'assistant_end');
    expect(end && end.type === 'assistant_end' && end.message).toMatchObject({ agentId: agent.id, status: 'complete' });

    const body = sentBody as unknown as { messages: { role: string; content: string }[]; temperature: number; max_tokens: number };
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(500);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toContain('Responde con foco en el modelo OSI.');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '¿En qué capa está IP?' });

    const updated = await json<{ agent: Agent }>(await request('GET', `/agents/${agent.id}`));
    expect(updated.agent.runs).toBe(1);
    expect(updated.agent.lastRunAt).not.toBeNull();
  });

  it('cambia el agente de una conversación y rechaza agentes deshabilitados o inexistentes', async () => {
    const { request } = createTestApp();
    const conv = (await json<{ conversation: Conversation }>(await request('POST', '/conversations', {}))).conversation;
    expect(conv.agentId).toBeNull();

    expect((await request('PATCH', `/conversations/${conv.id}`, { agentId: 'no-existe' })).status).toBe(404);
    const patched = await request('PATCH', `/conversations/${conv.id}`, { agentId: 'tutor' });
    expect((await json<{ conversation: Conversation }>(patched)).conversation.agentId).toBe('tutor');

    await request('PATCH', '/agents/tutor', { enabled: false });
    const blocked = await request('POST', `/conversations/${conv.id}/messages`, { ...MOCK, content: 'Hola' });
    expect(blocked.status).toBe(409);
    expect((await json<{ error: { kind: string } }>(blocked)).error.kind).toBe('policy');

    await request('PATCH', `/conversations/${conv.id}`, { agentId: null });
    const ok = await request('POST', `/conversations/${conv.id}/messages`, { ...MOCK, content: 'Hola' });
    expect(ok.status).toBe(200);
    await ok.text();
    const detail = await json<{ conversation: ConversationDetail }>(await request('GET', `/conversations/${conv.id}`));
    expect(detail.conversation.messages.at(-1)!.agentId).toBeNull();
  });

  it('borrar todos los datos restaura los agentes iniciales', async () => {
    const { request } = createTestApp();
    await createAgent(request);
    await request('PATCH', '/agents/tutor', { name: 'Profe' });
    await request('DELETE', '/data', { confirm: 'BORRAR' });
    const { agents } = await json<{ agents: Agent[] }>(await request('GET', '/agents'));
    expect(agents).toHaveLength(7);
    expect(agents.find((a) => a.id === 'tutor')!.name).toBe('Tutor');
  });
});

describe('modelos con restricción', () => {
  it('el servidor rechaza un modelo gratuito marcado como no utilizable desde la app', async () => {
    const provider = fakeProvider((url) => (url.endsWith('/models') ? Response.json({ data: [] }) : sseResponse([])), {
      knownModels: [
        {
          id: 'solo-cliente',
          name: 'Solo cliente',
          costClass: 'free',
          costSource: 'prueba',
          verifiedAt: null,
          restriction: 'Solo funciona desde el cliente oficial.',
        },
      ],
    });
    const { request } = createTestApp({ extraProviders: [provider] });
    await request('POST', '/providers/falso/consent', { accepted: true });
    const conv = (await json<{ conversation: Conversation }>(await request('POST', '/conversations', {}))).conversation;
    const res = await request('POST', `/conversations/${conv.id}/messages`, {
      providerId: 'falso',
      modelId: 'solo-cliente',
      content: 'Hola',
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: { kind: string; message: string } }>(res)).error.message).toMatch(/cliente oficial/);
  });
});
