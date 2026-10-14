import type { ModelInfo, Usage } from '../../shared/schemas.js';
import { classifyThrown, providerError } from './errors.js';
import type { GenerateRequest, GenerateResponse, ProviderAdapter } from './types.js';

/**
 * Proveedor simulado: no hace llamadas de red. Sirve para pruebas y para
 * probar la interfaz sin claves. Comandos en el último mensaje del usuario:
 *   /error 429 | 500 | 401 | 403 | 404 | timeout | red   → simula ese fallo
 *   /lento                                                → respuesta lenta (para probar Detener)
 * Si se pide JSON (planificación), devuelve un plan de ejemplo. En el
 * objetivo de la tarea:
 *   /plan invalido    → nunca devuelve un plan válido
 *   /plan reparable   → el primer intento es inválido y la corrección es válida
 */
export const MOCK_MODELS: ModelInfo[] = [
  {
    id: 'simulado-basico',
    name: 'Simulado básico',
    costClass: 'free',
    costSource: 'Proveedor local sin coste.',
    contextLength: 32_000,
    verifiedAt: null,
  },
];

export function createMockProvider(opts: { delayMs?: number; slowDelayMs?: number } = {}): ProviderAdapter {
  const delayMs = opts.delayMs ?? 15;
  const slowDelayMs = opts.slowDelayMs ?? 400;

  async function generateResponse(req: GenerateRequest): Promise<GenerateResponse> {
    if (!MOCK_MODELS.some((m) => m.id === req.modelId)) throw providerError('model_unavailable');
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const command = last.trim().toLowerCase();

    const simulated: Record<string, () => never> = {
      '/error 429': () => {
        throw providerError('rate_limit', { status: 429, retryAfterMs: 30_000 });
      },
      '/error 500': () => {
        throw providerError('server', { status: 500 });
      },
      '/error 401': () => {
        throw providerError('auth', { status: 401 });
      },
      '/error 403': () => {
        throw providerError('forbidden', { status: 403 });
      },
      '/error 404': () => {
        throw providerError('model_unavailable', { status: 404 });
      },
      '/error timeout': () => {
        throw providerError('timeout');
      },
      '/error red': () => {
        throw providerError('network');
      },
    };
    simulated[command]?.();

    if (req.responseFormat === 'json') {
      const all = req.messages.map((m) => m.content).join('\n');
      const isRepair = req.messages.some((m) => m.role === 'assistant');
      const invalid = all.includes('/plan invalido') || (all.includes('/plan reparable') && !isRepair);
      const text = invalid ? 'Aquí tienes el plan: (sin JSON)' : JSON.stringify(mockPlan());
      if (delayMs > 0) await sleep(delayMs, req.signal).catch(() => undefined);
      if (req.signal.aborted) throw classifyThrown(new DOMException('Cancelado', 'AbortError'), { userAborted: true, timedOut: false });
      return { text, finishReason: 'stop', rawUsage: { prompt_tokens: Math.ceil(all.length / 4), completion_tokens: 120, cost: 0 } };
    }

    const slow = command === '/lento';
    const text = slow
      ? 'Esta es una respuesta simulada lenta para que puedas probar el botón Detener. '.repeat(6).trim()
      : `Respuesta simulada. Recibí tu mensaje de ${last.length} caracteres y ${req.messages.length} mensaje(s) de contexto. ` +
        'Este proveedor no usa ningún modelo real; sirve para probar la aplicación sin coste.';

    const words = text.split(/(?<= )/);
    let out = '';
    const wait = slow ? slowDelayMs : delayMs;
    const timeout = AbortSignal.timeout(req.timeoutMs);
    try {
      for (const w of words) {
        if (wait > 0) await sleep(wait, AbortSignal.any([req.signal, timeout]));
        if (req.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        out += w;
        req.onDelta?.(w);
      }
    } catch (err) {
      throw classifyThrown(err, { userAborted: req.signal.aborted, timedOut: timeout.aborted });
    }
    return {
      text: out,
      finishReason: 'stop',
      rawUsage: { prompt_tokens: Math.ceil(last.length / 4), completion_tokens: words.length, cost: 0 },
    };
  }

  return {
    id: 'simulado',
    label: 'Simulado (sin red)',
    external: false,
    generateResponse,
    getProviderStatus: () => ({
      configured: true,
      notes: ['No envía datos fuera de tu equipo. Escribe /error 429 o /lento para simular situaciones.'],
    }),
    classifyProviderError: (error) => classifyThrown(error, { userAborted: false, timedOut: false }),
    getModelCapabilities: async () => ({ contextLength: 32_000, streaming: 'supported', structuredOutput: 'unsupported' }),
    supportsStructuredOutput: async () => 'unsupported',
    estimateCost: async () => ({ cost: 0, kind: 'estimated' }),
    getReportedUsage(response): Usage {
      const u = response.rawUsage as { prompt_tokens: number; completion_tokens: number } | null;
      return {
        promptTokens: u?.prompt_tokens ?? null,
        completionTokens: u?.completion_tokens ?? null,
        cost: 0,
        costKind: 'reported',
      };
    },
    listModels: async () => MOCK_MODELS,
  };
}

/** Plan válido de ejemplo con los agentes iniciales. */
function mockPlan() {
  return {
    interpretedObjective: 'Plan simulado para probar la aplicación sin coste.',
    complexity: { level: 2, justification: 'Nivel de ejemplo del proveedor simulado.' },
    acceptanceCriteria: ['La solución responde al objetivo.', 'Se indica cómo verificarla.'],
    subtasks: [
      {
        id: 's1',
        title: 'Analizar alternativas',
        description: 'Comparar enfoques posibles y elegir uno.',
        agentId: 'arquitecto',
        dependsOn: [],
        expectedOutput: 'Recomendación justificada.',
      },
      {
        id: 's2',
        title: 'Proponer la implementación',
        description: 'Desarrollar la alternativa elegida.',
        agentId: 'desarrollador',
        dependsOn: ['s1'],
        expectedOutput: 'Código o pasos concretos y cómo comprobarlos.',
      },
    ],
    reviewStrategy: 'El Revisor crítico evalúa la propuesta frente a los criterios de aceptación.',
    completionConditions: ['Todos los criterios se cumplen o quedan justificados.'],
    assumptions: ['Proveedor simulado: no hay análisis real.'],
    questions: [],
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Cancelado', 'AbortError'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Cancelado', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
