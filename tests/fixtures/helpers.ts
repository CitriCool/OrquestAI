import { createApp } from '../../src/server/app.js';
import { createMockProvider } from '../../src/server/providers/mock.js';
import { createOpenAICompatibleProvider, type OpenAICompatibleOptions } from '../../src/server/providers/openaiCompatible.js';
import type { ProviderAdapter } from '../../src/server/providers/types.js';
import { allowedHosts } from '../../src/server/security/localGuard.js';
import { openDatabase, type DB } from '../../src/server/storage/db.js';
import { Repository } from '../../src/server/storage/repository.js';
import type { ChatEvent } from '../../src/shared/schemas.js';

export const TOKEN = 'token-de-prueba-0123456789abcdefghijklmnop';
export const HOST = '127.0.0.1:4317';
export const FAKE_KEY = 'sk-or-v1-clave-falsa-para-pruebas-1234567890';

/** Respuesta SSE de chat completions con los fragmentos indicados. */
export function sseResponse(lines: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

export function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

export type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response;

export function fakeProvider(
  handler: FetchHandler,
  overrides: Partial<OpenAICompatibleOptions> = {},
): ProviderAdapter {
  return createOpenAICompatibleProvider({
    id: 'falso',
    label: 'Proveedor falso',
    baseUrl: 'https://proveedor.invalid/v1',
    apiKey: FAKE_KEY,
    apiKeyEnvName: 'FALSO_API_KEY',
    pricingFromModelList: true,
    fetchImpl: ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch,
    ...overrides,
  });
}

/** Listado de modelos al estilo OpenRouter. */
export function modelList(): Response {
  return Response.json({
    data: [
      { id: 'gratis/modelo:free', name: 'Gratis', context_length: 8000, pricing: { prompt: '0', completion: '0' } },
      { id: 'pago/modelo', name: 'De pago', context_length: 8000, pricing: { prompt: '0.000002', completion: '0.000004' } },
      { id: 'sin/precio', name: 'Sin precio' },
    ],
  });
}

export function createTestApp(opts: { db?: DB; extraProviders?: ProviderAdapter[] } = {}) {
  const db = opts.db ?? openDatabase(':memory:');
  const repo = new Repository(db);
  const providers = new Map<string, ProviderAdapter>(
    [createMockProvider({ delayMs: 0, slowDelayMs: 25 }), ...(opts.extraProviders ?? [])].map((p) => [p.id, p]),
  );
  const app = createApp({
    repo,
    providers,
    token: TOKEN,
    allowedHosts: allowedHosts(4317),
    providerTimeoutMs: 2_000,
  });

  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://${HOST}/api${path}`, {
      method,
      headers: {
        host: HOST,
        'x-orquestai-token': TOKEN,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });

  return { app, db, repo, request };
}

export function parseSse(text: string): ChatEvent[] {
  return text
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n'),
    )
    .filter(Boolean)
    .map((d) => JSON.parse(d) as ChatEvent);
}
