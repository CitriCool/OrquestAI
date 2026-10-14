import type {
  Agent,
  ChatEvent,
  Conversation,
  ConversationDetail,
  ErrorKind,
  ModelInfo,
  ProviderStatus,
  SendMessageInput,
  Task,
  TaskDetail,
  UpdateAgentInput,
} from '../shared/schemas.js';
import type { ComplexityLevel, ReviewLevel } from '../shared/schemas.js';

/** Datos editables de un agente nuevo (los valores por omisión los completa el servidor). */
export type NewAgent = UpdateAgentInput & { name: string; instructions: string; role?: 'specialist' | 'custom' };

export class ApiError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly action: string,
  ) {
    super(message);
  }
}

let token: string | null = null;

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/session');
  if (!res.ok) throw await toApiError(res);
  token = ((await res.json()) as { token: string }).token;
  return token;
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { kind: ErrorKind; message: string; action: string } };
    if (body.error) return new ApiError(body.error.kind, body.error.message, body.error.action);
  } catch {
    // respuesta sin JSON
  }
  return new ApiError('unknown', `El servidor respondió con el código ${res.status}.`, 'Comprueba que el servidor local esté en marcha.');
}

/** Envía una petición con el token de sesión; si el servidor se reinició, renueva el token una vez. */
async function send(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
  const t = token ?? (await fetchToken());
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'x-orquestai-token': t, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('network', 'No se pudo contactar con el servidor local.', 'Comprueba que la aplicación siga en ejecución.');
  }
  if (res.status === 401 && retry) {
    token = null;
    return send(method, path, body, false);
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await (await send(method, path, body)).json()) as T;
}

export const api = {
  listConversations: () => json<{ conversations: Conversation[] }>('GET', '/conversations').then((r) => r.conversations),
  createConversation: (agentId: string | null = null) =>
    json<{ conversation: Conversation }>('POST', '/conversations', { agentId }).then((r) => r.conversation),
  getConversation: (id: string) =>
    json<{ conversation: ConversationDetail; running: boolean }>('GET', `/conversations/${encodeURIComponent(id)}`),
  renameConversation: (id: string, title: string) =>
    json<{ conversation: Conversation }>('PATCH', `/conversations/${encodeURIComponent(id)}`, { title }),
  setConversationAgent: (id: string, agentId: string | null) =>
    json<{ conversation: Conversation }>('PATCH', `/conversations/${encodeURIComponent(id)}`, { agentId }),
  deleteConversation: (id: string) => json('DELETE', `/conversations/${encodeURIComponent(id)}`),
  stop: (id: string) => json<{ stopped: boolean }>('POST', `/conversations/${encodeURIComponent(id)}/stop`),
  listAgents: () => json<{ agents: Agent[] }>('GET', '/agents').then((r) => r.agents),
  createAgent: (input: NewAgent) => json<{ agent: Agent }>('POST', '/agents', input).then((r) => r.agent),
  updateAgent: (id: string, input: UpdateAgentInput) =>
    json<{ agent: Agent }>('PATCH', `/agents/${encodeURIComponent(id)}`, input).then((r) => r.agent),
  deleteAgent: (id: string) => json('DELETE', `/agents/${encodeURIComponent(id)}`),
  resetAgent: (id: string) =>
    json<{ agent: Agent }>('POST', `/agents/${encodeURIComponent(id)}/reset`).then((r) => r.agent),
  listTasks: () => json<{ tasks: Task[] }>('GET', '/tasks').then((r) => r.tasks),
  createTask: (input: {
    objective: string;
    context: string;
    acceptanceCriteria: string;
    reviewLevel: ReviewLevel;
    complexityOverride: ComplexityLevel | null;
  }) => json<{ task: Task }>('POST', '/tasks', input).then((r) => r.task),
  getTask: (id: string) =>
    json<{ task: TaskDetail; planning: boolean; executing: boolean }>('GET', `/tasks/${encodeURIComponent(id)}`),
  updateTask: (id: string, input: { title?: string; complexityOverride?: ComplexityLevel | null }) =>
    json<{ task: TaskDetail }>('PATCH', `/tasks/${encodeURIComponent(id)}`, input),
  planTask: (id: string, input: { providerId: string; modelId: string; feedback?: string }) =>
    json<{ task: TaskDetail }>('POST', `/tasks/${encodeURIComponent(id)}/plan`, input),
  executeTask: (id: string, input: { providerId: string; modelId: string }) =>
    json<{ task: TaskDetail }>('POST', `/tasks/${encodeURIComponent(id)}/execute`, input),
  acceptTask: (id: string) => json<{ task: TaskDetail }>('POST', `/tasks/${encodeURIComponent(id)}/accept`),
  stopTask: (id: string) => json<{ stopped: boolean }>('POST', `/tasks/${encodeURIComponent(id)}/stop`),
  approvePlan: (id: string, planId: string) =>
    json<{ task: TaskDetail }>('POST', `/tasks/${encodeURIComponent(id)}/approve`, { planId }),
  cancelTask: (id: string) => json<{ task: TaskDetail }>('POST', `/tasks/${encodeURIComponent(id)}/cancel`),
  deleteTask: (id: string) => json('DELETE', `/tasks/${encodeURIComponent(id)}`),
  listProviders: () => json<{ providers: ProviderStatus[] }>('GET', '/providers').then((r) => r.providers),
  listModels: (providerId: string) =>
    json<{ models: ModelInfo[] }>('GET', `/providers/${encodeURIComponent(providerId)}/models`).then((r) => r.models),
  giveConsent: (providerId: string) => json('POST', `/providers/${encodeURIComponent(providerId)}/consent`, { accepted: true }),
  getSettings: () => json<{ defaultProviderId: string; defaultModelId: string }>('GET', '/settings'),
  saveSettings: (s: { defaultProviderId: string; defaultModelId: string }) => json('PUT', '/settings', s),
  deleteAllData: () => json('DELETE', '/data', { confirm: 'BORRAR' }),

  /** Envía un mensaje y recibe la respuesta como eventos SSE. */
  async sendMessage(conversationId: string, input: SendMessageInput, onEvent: (e: ChatEvent) => void): Promise<void> {
    const res = await send('POST', `/conversations/${encodeURIComponent(conversationId)}/messages`, input);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) onEvent(JSON.parse(data) as ChatEvent);
      }
    }
  },
};
