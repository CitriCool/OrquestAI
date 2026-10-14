import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/server/storage/db.js';
import { clearRegisteredSecrets, registerSecret } from '../../src/server/security/redact.js';
import type { Conversation, ConversationDetail, ProviderStatus } from '../../src/shared/schemas.js';
import { chunk, createTestApp, fakeProvider, FAKE_KEY, HOST, modelList, parseSse, sseResponse, TOKEN } from '../fixtures/helpers.js';

const MOCK = { providerId: 'simulado', modelId: 'simulado-basico' };

async function newConversation(request: ReturnType<typeof createTestApp>['request']): Promise<Conversation> {
  const res = await request('POST', '/conversations', {});
  expect(res.status).toBe(201);
  return ((await res.json()) as { conversation: Conversation }).conversation;
}

async function getDetail(request: ReturnType<typeof createTestApp>['request'], id: string) {
  return (await (await request('GET', `/conversations/${id}`)).json()) as { conversation: ConversationDetail; running: boolean };
}

describe('seguridad del servidor local', () => {
  it('exige el token de sesión', async () => {
    const { request } = createTestApp();
    const res = await request('GET', '/conversations', undefined, { 'x-orquestai-token': 'incorrecto' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Sesión/);
  });

  it('entrega el token solo a peticiones locales del mismo origen', async () => {
    const { app } = createTestApp();
    const ok = await app.request(`http://${HOST}/api/session`, { headers: { host: HOST } });
    expect(((await ok.json()) as { token: string }).token).toBe(TOKEN);
    const crossSite = await app.request(`http://${HOST}/api/session`, {
      headers: { host: HOST, 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('rechaza Host u Origin no locales (DNS rebinding, otras webs)', async () => {
    const { request } = createTestApp();
    expect((await request('GET', '/conversations', undefined, { host: 'atacante.com' })).status).toBe(403);
    expect((await request('GET', '/conversations', undefined, { origin: 'https://atacante.com' })).status).toBe(403);
    expect((await request('GET', '/conversations', undefined, { origin: `http://${HOST}` })).status).toBe(200);
  });

  it('limita el tamaño de la solicitud y valida los datos', async () => {
    const { request } = createTestApp();
    const c = await newConversation(request);
    const big = await request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: 'x'.repeat(300_000) });
    expect(big.status).toBe(413);
    const invalid = await request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: '' });
    expect(invalid.status).toBe(400);
    const notJson = await request('POST', '/conversations', '{no es json');
    expect(notJson.status).toBe(400);
  });
});

describe('conversaciones', () => {
  it('crea, renombra, lista y elimina', async () => {
    const { request } = createTestApp();
    const c = await newConversation(request);
    expect((await request('PATCH', `/conversations/${c.id}`, { title: 'Redes' })).status).toBe(200);
    const list = (await (await request('GET', '/conversations')).json()) as { conversations: Conversation[] };
    expect(list.conversations.map((x) => x.title)).toEqual(['Redes']);
    expect((await request('DELETE', `/conversations/${c.id}`)).status).toBe(200);
    expect((await request('GET', `/conversations/${c.id}`)).status).toBe(404);
  });

  it('conversa con el proveedor simulado, guarda todo y titula la conversación', async () => {
    const { request } = createTestApp();
    const c = await newConversation(request);
    const res = await request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: '¿Qué es TCP?' });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['user_message', 'assistant_start', 'delta', 'assistant_end']));
    const { conversation } = await getDetail(request, c.id);
    expect(conversation.title).toBe('¿Qué es TCP?');
    expect(conversation.messages).toHaveLength(2);
    const reply = conversation.messages[1]!;
    expect(reply.status).toBe('complete');
    expect(reply.content).toMatch(/Respuesta simulada/);
    expect(reply.providerId).toBe('simulado');
    expect(reply.usage?.costKind).toBe('reported');
  });

  it('las conversaciones persisten al reiniciar la aplicación', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orquestai-'));
    try {
      const file = path.join(dir, 'app.db');
      const first = createTestApp({ db: openDatabase(file) });
      const c = await newConversation(first.request);
      await (await first.request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: 'hola' })).text();
      first.db.close();

      const second = createTestApp({ db: openDatabase(file) });
      const { conversation } = await getDetail(second.request, c.id);
      expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('errores, detención y concurrencia', () => {
  it('guarda el error clasificado y la disponibilidad observada', async () => {
    const { request } = createTestApp();
    const c = await newConversation(request);
    const events = parseSse(await (await request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: '/error 429' })).text());
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ kind: 'rate_limit' });
    const { conversation } = await getDetail(request, c.id);
    expect(conversation.messages[1]).toMatchObject({ status: 'error', errorKind: 'rate_limit' });
    const providers = (await (await request('GET', '/providers')).json()) as { providers: ProviderStatus[] };
    expect(providers.providers.find((p) => p.id === 'simulado')?.lastErrorKind).toBe('rate_limit');
  });

  it('Detener conserva la respuesta parcial y rechaza un segundo envío simultáneo', async () => {
    const { request } = createTestApp();
    const c = await newConversation(request);
    const pending = request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: '/lento' });
    const res = await pending;
    const reader = res.body!.getReader();
    // Espera a recibir algunos fragmentos.
    let received = '';
    while ((received.match(/event: delta/g) ?? []).length < 2) {
      const { value } = await reader.read();
      received += new TextDecoder().decode(value);
    }
    const second = await request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: 'otro' });
    expect(second.status).toBe(409);
    expect(((await (await request('POST', `/conversations/${c.id}/stop`)).json()) as { stopped: boolean }).stopped).toBe(true);
    while (!(await reader.read()).done) {
      // consume el resto
    }
    const { conversation, running } = await getDetail(request, c.id);
    expect(running).toBe(false);
    const reply = conversation.messages.at(-1)!;
    expect(reply.status).toBe('cancelled');
    expect(reply.content.length).toBeGreaterThan(0);
  });

  it('eliminar una conversación durante la respuesta la detiene sin dejar datos', async () => {
    const { request, db } = createTestApp();
    const c = await newConversation(request);
    const res = await request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: '/lento' });
    const reader = res.body!.getReader();
    await reader.read();
    expect((await request('DELETE', `/conversations/${c.id}`)).status).toBe(200);
    while (!(await reader.read()).done) {
      // consume el resto
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });
});

describe('proveedores externos y política de costes', () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    registerSecret(FAKE_KEY);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearRegisteredSecrets();
  });

  function external(onChat: (init: RequestInit) => Response) {
    const provider = fakeProvider((url, init) => (url.endsWith('/models') ? modelList() : onChat(init)));
    return createTestApp({ extraProviders: [provider] });
  }

  it('exige aceptar el aviso antes de enviar contenido a un proveedor externo', async () => {
    let calls = 0;
    const { request } = external(() => {
      calls++;
      return sseResponse([chunk('ok'), 'data: [DONE]\n\n']);
    });
    const c = await newConversation(request);
    const input = { providerId: 'falso', modelId: 'gratis/modelo:free', content: 'hola' };
    const blocked = await request('POST', `/conversations/${c.id}/messages`, input);
    expect(blocked.status).toBe(409);
    expect(calls).toBe(0);
    expect((await getDetail(request, c.id)).conversation.messages).toHaveLength(0);

    expect((await request('POST', '/providers/falso/consent', { accepted: true })).status).toBe(200);
    const ok = await request('POST', `/conversations/${c.id}/messages`, input);
    expect(ok.status).toBe(200);
    await ok.text();
    expect(calls).toBe(1);
    expect((await getDetail(request, c.id)).conversation.messages[1]!.content).toBe('ok');
  });

  it('bloquea en el servidor modelos de pago o de coste desconocido', async () => {
    let calls = 0;
    const { request } = external(() => {
      calls++;
      return sseResponse(['data: [DONE]\n\n']);
    });
    await request('POST', '/providers/falso/consent', { accepted: true });
    const c = await newConversation(request);
    for (const modelId of ['pago/modelo', 'sin/precio']) {
      const res = await request('POST', `/conversations/${c.id}/messages`, { providerId: 'falso', modelId, content: 'hola' });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('policy');
    }
    const missing = await request('POST', `/conversations/${c.id}/messages`, { providerId: 'falso', modelId: 'no/existe', content: 'x' });
    expect(missing.status).toBe(400);
    expect(calls).toBe(0);
  });

  it('un proveedor sin clave se informa como no configurado', async () => {
    const provider = fakeProvider(() => modelList(), { apiKey: null });
    const { request } = createTestApp({ extraProviders: [provider] });
    const c = await newConversation(request);
    const res = await request('POST', `/conversations/${c.id}/messages`, { providerId: 'falso', modelId: 'x', content: 'hola' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('config');
  });

  it('la clave API no aparece en respuestas, mensajes guardados ni registros', async () => {
    const { request, db } = external(
      () => new Response(JSON.stringify({ error: { message: `Invalid key ${FAKE_KEY}` } }), { status: 401 }),
    );
    await request('POST', '/providers/falso/consent', { accepted: true });
    const c = await newConversation(request);
    const res = await request('POST', `/conversations/${c.id}/messages`, {
      providerId: 'falso',
      modelId: 'gratis/modelo:free',
      content: 'hola',
    });
    const body = await res.text();
    expect(parseSse(body).find((e) => e.type === 'error')).toMatchObject({ kind: 'auth' });

    const everything = [
      body,
      await (await request('GET', `/conversations/${c.id}`)).text(),
      await (await request('GET', '/providers')).text(),
      JSON.stringify(db.prepare('SELECT * FROM messages').all()),
      JSON.stringify(db.prepare('SELECT * FROM settings').all()),
      ...logs,
    ].join('\n');
    expect(everything).not.toContain(FAKE_KEY);
  });
});

describe('ajustes y borrado', () => {
  it('guarda el modelo por defecto y elimina todos los datos locales con confirmación', async () => {
    const { request, db } = createTestApp();
    expect((await request('PUT', '/settings', { defaultProviderId: 'simulado', defaultModelId: 'simulado-basico' })).status).toBe(200);
    const c = await newConversation(request);
    await (await request('POST', `/conversations/${c.id}/messages`, { ...MOCK, content: 'hola' })).text();

    expect((await request('DELETE', '/data', { confirm: 'no' })).status).toBe(400);
    expect((await request('DELETE', '/data', { confirm: 'BORRAR' })).status).toBe(200);
    for (const table of ['conversations', 'messages', 'settings']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});
