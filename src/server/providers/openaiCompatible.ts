import type { ModelInfo, Usage } from '../../shared/schemas.js';
import { classifyHttpError, classifyThrown, providerError } from './errors.js';
import type {
  CostEstimate,
  GenerateRequest,
  GenerateResponse,
  ModelCapabilities,
  ProviderAdapter,
  ProviderError,
  Support,
} from './types.js';

/** Datos de un modelo conocidos por configuración, con su fuente. */
export interface KnownModel {
  id: string;
  name: string;
  costClass: ModelInfo['costClass'];
  costSource: string;
  verifiedAt: string | null;
  contextLength?: number | null;
}

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  /** Sin barra final, p. ej. https://openrouter.ai/api/v1 */
  baseUrl: string;
  apiKey: string | null;
  apiKeyEnvName: string;
  extraHeaders?: Record<string, string>;
  /** Pide el uso en el último fragmento del stream (parámetro estándar stream_options). */
  requestStreamUsage?: boolean;
  /** Interpreta el campo `pricing` del listado de modelos (formato OpenRouter). */
  pricingFromModelList?: boolean;
  knownModels?: KnownModel[];
  notes?: string[];
  fetchImpl?: typeof fetch;
  modelCacheMs?: number;
}

interface ListedModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
}

/**
 * Adaptador para APIs con formato de chat completions de OpenAI.
 * Lo comparten OpenRouter y OpenCode Zen para no duplicar lógica.
 */
export function createOpenAICompatibleProvider(opts: OpenAICompatibleOptions): ProviderAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const cacheMs = opts.modelCacheMs ?? 10 * 60_000;
  let modelCache: { at: number; models: ModelInfo[] } | null = null;

  function headers(): Record<string, string> {
    if (!opts.apiKey) throw providerError('config', { detail: `Falta la variable ${opts.apiKeyEnvName}.` });
    return {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      ...opts.extraHeaders,
    };
  }

  function knownModel(id: string): KnownModel | undefined {
    return opts.knownModels?.find((m) => m.id === id);
  }

  function fromListing(m: ListedModel, verifiedAt: string): ModelInfo | null {
    if (typeof m.id !== 'string' || !m.id) return null;
    const known = knownModel(m.id);
    if (known) {
      return {
        id: known.id,
        name: known.name,
        costClass: known.costClass,
        costSource: known.costSource,
        contextLength: known.contextLength ?? (typeof m.context_length === 'number' ? m.context_length : null),
        verifiedAt: known.verifiedAt,
      };
    }
    let costClass: ModelInfo['costClass'] = 'unknown';
    let costSource = 'El proveedor no informa el precio en su listado.';
    if (opts.pricingFromModelList && m.pricing) {
      const prompt = Number(m.pricing.prompt);
      const completion = Number(m.pricing.completion);
      if (Number.isFinite(prompt) && Number.isFinite(completion)) {
        costClass = prompt === 0 && completion === 0 ? 'free' : 'standard';
        costSource = 'Precio informado por el listado de modelos del proveedor.';
      }
    }
    return {
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      costClass,
      costSource,
      contextLength: typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null,
      verifiedAt,
    };
  }

  async function listModels(): Promise<ModelInfo[]> {
    if (modelCache && Date.now() - modelCache.at < cacheMs) return modelCache.models;
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/models`, {
        headers: headers(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw classifyThrown(err, { userAborted: false, timedOut: false });
    }
    if (!res.ok) throw classifyHttpError(res.status, await res.text(), res.headers.get('retry-after'));
    const body = (await res.json()) as { data?: ListedModel[] };
    const verifiedAt = new Date().toISOString();
    const models = (body.data ?? [])
      .map((m) => fromListing(m, verifiedAt))
      .filter((m): m is ModelInfo => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    // Modelos conocidos por configuración que el listado no incluyó.
    for (const k of opts.knownModels ?? []) {
      if (!models.some((m) => m.id === k.id)) {
        models.unshift({
          id: k.id,
          name: k.name,
          costClass: k.costClass,
          costSource: k.costSource,
          contextLength: k.contextLength ?? null,
          verifiedAt: k.verifiedAt,
        });
      }
    }
    modelCache = { at: Date.now(), models };
    return models;
  }

  async function findModel(modelId: string): Promise<ModelInfo | null> {
    const known = knownModel(modelId);
    try {
      const list = await listModels();
      return list.find((m) => m.id === modelId) ?? null;
    } catch (err) {
      if (known) {
        return { ...known, contextLength: known.contextLength ?? null };
      }
      throw err;
    }
  }

  async function generateResponse(req: GenerateRequest): Promise<GenerateResponse> {
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    const stream = typeof req.onDelta === 'function';
    const body: Record<string, unknown> = {
      model: req.modelId,
      messages: req.messages,
      stream,
    };
    if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
    if (stream && opts.requestStreamUsage) body.stream_options = { include_usage: true };

    const ctx = () => ({ userAborted: req.signal.aborted, timedOut: timeout.aborted });
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw classifyThrown(err, ctx());
    }
    if (!res.ok) {
      throw classifyHttpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'));
    }

    try {
      if (!stream) {
        const json = (await res.json()) as ChatCompletion;
        if (json.error) throw errorFromPayload(json.error);
        const choice = json.choices?.[0];
        return {
          text: choice?.message?.content ?? '',
          finishReason: choice?.finish_reason ?? null,
          rawUsage: json.usage ?? null,
        };
      }
      return await readStream(res, req.onDelta!);
    } catch (err) {
      throw classifyThrown(err, ctx());
    }
  }

  function getReportedUsage(response: GenerateResponse): Usage {
    const u = (response.rawUsage ?? null) as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      cost?: unknown;
    } | null;
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
    const cost = u && typeof u.cost === 'number' && u.cost >= 0 ? u.cost : null;
    return {
      promptTokens: int(u?.prompt_tokens),
      completionTokens: int(u?.completion_tokens),
      cost,
      costKind: cost === null ? 'unknown' : 'reported',
    };
  }

  return {
    id: opts.id,
    label: opts.label,
    external: true,
    generateResponse,
    getProviderStatus() {
      const notes = [...(opts.notes ?? [])];
      if (!opts.apiKey) notes.unshift(`Sin clave: define ${opts.apiKeyEnvName} en el archivo .env.`);
      return { configured: !!opts.apiKey, notes };
    },
    classifyProviderError(error: unknown): ProviderError {
      return classifyThrown(error, { userAborted: false, timedOut: false });
    },
    async getModelCapabilities(modelId: string): Promise<ModelCapabilities> {
      const model = await findModel(modelId).catch(() => null);
      return {
        contextLength: model?.contextLength ?? null,
        streaming: 'supported',
        // Depende de cada modelo; no se supone soporte hasta verificarlo (Fase 2).
        structuredOutput: 'unknown',
      };
    },
    async supportsStructuredOutput(): Promise<Support> {
      return 'unknown';
    },
    async estimateCost(request): Promise<CostEstimate> {
      const model = await findModel(request.modelId).catch(() => null);
      if (model?.costClass === 'free') return { cost: 0, kind: 'estimated' };
      // Los precios por token se incorporan en la Fase 3.
      return { cost: null, kind: 'unknown' };
    },
    getReportedUsage,
    listModels,
  };
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function errorFromPayload(error: { code?: unknown; message?: unknown }): ProviderError {
  const status = typeof error.code === 'number' ? error.code : 0;
  const message = typeof error.message === 'string' ? error.message : '';
  return classifyHttpError(status || 500, JSON.stringify({ error: { message } }));
}

/** Lee un stream SSE de chat completions. Ignora comentarios y líneas vacías. */
async function readStream(res: Response, onDelta: (text: string) => void): Promise<GenerateResponse> {
  if (!res.body) throw providerError('server', { detail: 'Respuesta sin contenido.' });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason: string | null = null;
  let usage: unknown = null;
  let done = false;

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return; // comentarios (": ...") y otros campos
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let chunk: ChatCompletion;
    try {
      chunk = JSON.parse(data) as ChatCompletion;
    } catch {
      return; // fragmento no interpretable: se ignora, el texto ya recibido se conserva
    }
    if (chunk.error) throw errorFromPayload(chunk.error);
    const choice = chunk.choices?.[0];
    const piece = choice?.delta?.content;
    if (piece) {
      text += piece;
      onDelta(piece);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        if (done) break;
      }
    }
    if (!done && buffer.trim()) handleLine(buffer.trim());
  } finally {
    reader.releaseLock();
  }
  return { text, finishReason, rawUsage: usage };
}
