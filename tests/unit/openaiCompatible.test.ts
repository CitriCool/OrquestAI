import { describe, expect, it } from 'vitest';
import { chunk, fakeProvider, FAKE_KEY, modelList, sseResponse } from '../fixtures/helpers.js';

const base = () => ({ modelId: 'm', messages: [{ role: 'user' as const, content: 'hola' }], timeoutMs: 1_000 });

describe('adaptador compatible con OpenAI', () => {
  it('lee el stream: ignora comentarios, une fragmentos partidos y captura el uso', async () => {
    let sentBody: Record<string, unknown> = {};
    let sentHeaders: Record<string, string> = {};
    const provider = fakeProvider(
      (_url, init) => {
        sentBody = JSON.parse(String(init.body));
        sentHeaders = init.headers as Record<string, string>;
        const c1 = chunk('Hola ');
        return sseResponse([
          ': OPENROUTER PROCESSING\n\n',
          c1.slice(0, 10),
          c1.slice(10),
          chunk('mundo'),
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0 } })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      },
      { requestStreamUsage: true },
    );
    const deltas: string[] = [];
    const res = await provider.generateResponse({ ...base(), signal: new AbortController().signal, onDelta: (t) => deltas.push(t) });
    expect(res.text).toBe('Hola mundo');
    expect(deltas).toEqual(['Hola ', 'mundo']);
    expect(res.finishReason).toBe('stop');
    expect(provider.getReportedUsage(res)).toEqual({ promptTokens: 5, completionTokens: 2, cost: 0, costKind: 'reported' });
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(sentHeaders.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('sin coste informado, el coste es desconocido (no se inventa)', () => {
    const provider = fakeProvider(() => new Response());
    expect(provider.getReportedUsage({ text: '', finishReason: null, rawUsage: { prompt_tokens: 1 } }).costKind).toBe('unknown');
  });

  it('clasifica un 429 con Retry-After', async () => {
    const provider = fakeProvider(() => new Response('{"error":{"message":"rate"}}', { status: 429, headers: { 'retry-after': '7' } }));
    await expect(provider.generateResponse({ ...base(), signal: new AbortController().signal })).rejects.toMatchObject({
      kind: 'rate_limit',
      opts: { retryAfterMs: 7_000 },
    });
  });

  it('clasifica un error enviado dentro del stream', async () => {
    const provider = fakeProvider(() =>
      sseResponse([chunk('parcial'), `data: ${JSON.stringify({ error: { code: 502, message: 'upstream' } })}\n\n`]),
    );
    await expect(
      provider.generateResponse({ ...base(), signal: new AbortController().signal, onDelta: () => undefined }),
    ).rejects.toMatchObject({ kind: 'server' });
  });

  it('respeta el tiempo máximo por llamada', async () => {
    const provider = fakeProvider(
      (_u, init) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))),
        ),
    );
    await expect(provider.generateResponse({ ...base(), timeoutMs: 30, signal: new AbortController().signal })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('distingue la cancelación del usuario de un tiempo agotado', async () => {
    const provider = fakeProvider(
      (_u, init) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))),
        ),
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(provider.generateResponse({ ...base(), signal: ac.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('sin clave devuelve un error de configuración sin llamar a la red', async () => {
    let called = false;
    const provider = fakeProvider(
      () => {
        called = true;
        return new Response();
      },
      { apiKey: null },
    );
    expect(provider.getProviderStatus().configured).toBe(false);
    await expect(provider.generateResponse({ ...base(), signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'config' });
    expect(called).toBe(false);
  });

  it('clasifica el coste de los modelos según el listado y la configuración conocida', async () => {
    const provider = fakeProvider(() => modelList(), {
      knownModels: [{ id: 'sin/precio', name: 'Conocido', costClass: 'free', costSource: 'docs', verifiedAt: '2026-10-14' }],
    });
    const models = await provider.listModels();
    const byId = Object.fromEntries(models.map((m) => [m.id, m.costClass]));
    expect(byId).toEqual({ 'gratis/modelo:free': 'free', 'pago/modelo': 'standard', 'sin/precio': 'free' });
    const unknown = fakeProvider(() => modelList(), { pricingFromModelList: false });
    expect((await unknown.listModels()).every((m) => m.costClass === 'unknown')).toBe(true);
  });
});
