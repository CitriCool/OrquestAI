import type { TaskRun } from '../../shared/schemas.js';
import { ProviderError, type ChatTurn, type ProviderAdapter } from '../providers/types.js';
import type { Repository } from '../storage/repository.js';
import type { TaskRepository } from '../storage/taskRepository.js';

export interface RecordedCall {
  run: TaskRun;
  text: string;
  finishReason: string | null;
}

/**
 * Una llamada a un modelo dentro de una tarea, registrada en el historial
 * (estado, texto devuelto, uso y errores). Si falla, lanza el ProviderError.
 */
export async function recordedCall(
  deps: { repo: Repository; tasks: TaskRepository; timeoutMs: number },
  input: {
    run: Parameters<TaskRepository['startRun']>[0];
    provider: ProviderAdapter;
    messages: ChatTurn[];
    maxOutputTokens?: number;
    temperature?: number;
    responseFormat?: 'text' | 'json';
    signal: AbortSignal;
    onStart?: (run: TaskRun) => void;
  },
): Promise<RecordedCall> {
  const run = deps.tasks.startRun(input.run);
  input.onStart?.(run);
  try {
    const response = await input.provider.generateResponse({
      modelId: input.run.modelId,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      temperature: input.temperature,
      responseFormat: input.responseFormat,
      signal: input.signal,
      timeoutMs: deps.timeoutMs,
    });
    deps.tasks.finishRun(run.id, {
      status: 'complete',
      output: response.text,
      usage: input.provider.getReportedUsage(response),
    });
    deps.repo.recordObservation(input.provider.id, { ok: true });
    return { run, text: response.text, finishReason: response.finishReason };
  } catch (err) {
    const e = err instanceof ProviderError ? err : input.provider.classifyProviderError(err);
    deps.tasks.finishRun(run.id, {
      status: e.kind === 'cancelled' ? 'cancelled' : 'error',
      errorKind: e.kind,
      errorMessage: e.message,
    });
    if (e.kind !== 'cancelled') deps.repo.recordObservation(input.provider.id, { ok: false, kind: e.kind });
    throw e;
  }
}

/** Los modelos de razonamiento pueden gastar el límite de tokens sin llegar a escribir la respuesta. */
export function emptyResponseError(finishReason: string | null, what: string): string {
  return finishReason === 'length'
    ? `El modelo agotó el límite de tokens sin entregar ${what} (probablemente lo gastó razonando). Prueba con otro modelo.`
    : 'El modelo devolvió una respuesta vacía.';
}
