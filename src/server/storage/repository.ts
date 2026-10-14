import { randomUUID } from 'node:crypto';
import type {
  Agent,
  Conversation,
  CreateAgentInput,
  ErrorKind,
  Message,
  UpdateAgentInput,
  Usage,
} from '../../shared/schemas.js';
import { DEFAULT_AGENTS, findDefaultAgent } from '../agents/defaults.js';
import { redact } from '../security/redact.js';
import type { DB } from './db.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  provider_id: string | null;
  model_id: string | null;
  status: Message['status'];
  error_kind: ErrorKind | null;
  error_message: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
  cost_kind: Usage['costKind'] | null;
  agent_id: string | null;
  created_at: string;
}

interface ConversationRow {
  id: string;
  title: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  role: Agent['role'];
  instructions: string;
  specialty: string | null;
  provider_id: string | null;
  model_id: string | null;
  fallback_provider_id: string | null;
  fallback_model_id: string | null;
  max_output_tokens: number | null;
  temperature: number | null;
  enabled: number;
  builtin: number;
  created_at: string;
  updated_at: string;
  runs: number;
  last_run_at: string | null;
}

/** Columnas editables del agente y su campo en la API. */
const AGENT_COLUMNS = {
  name: 'name',
  description: 'description',
  instructions: 'instructions',
  specialty: 'specialty',
  providerId: 'provider_id',
  modelId: 'model_id',
  fallbackProviderId: 'fallback_provider_id',
  fallbackModelId: 'fallback_model_id',
  maxOutputTokens: 'max_output_tokens',
  temperature: 'temperature',
  enabled: 'enabled',
} as const satisfies Record<keyof UpdateAgentInput, string>;

/** Agentes con su historial de ejecuciones: respuestas en chats y llamadas dentro de tareas. */
const AGENT_SELECT = `
  SELECT a.*, COUNT(r.agent_id) AS runs, MAX(r.at) AS last_run_at
  FROM agents a
  LEFT JOIN (
    SELECT agent_id, created_at AS at FROM messages WHERE role = 'assistant' AND agent_id IS NOT NULL
    UNION ALL
    SELECT agent_id, started_at AS at FROM task_runs WHERE agent_id IS NOT NULL
  ) r ON r.agent_id = a.id`;

const now = () => new Date().toISOString();

function toConversation(r: ConversationRow): Conversation {
  return { id: r.id, title: r.title, agentId: r.agent_id, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    role: r.role,
    instructions: r.instructions,
    specialty: r.specialty,
    providerId: r.provider_id,
    modelId: r.model_id,
    fallbackProviderId: r.fallback_provider_id,
    fallbackModelId: r.fallback_model_id,
    maxOutputTokens: r.max_output_tokens,
    temperature: r.temperature,
    enabled: r.enabled === 1,
    builtin: r.builtin === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    runs: r.runs,
    lastRunAt: r.last_run_at,
  };
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    providerId: r.provider_id,
    modelId: r.model_id,
    status: r.status,
    errorKind: r.error_kind,
    errorMessage: r.error_message,
    usage: r.cost_kind
      ? {
          promptTokens: r.prompt_tokens,
          completionTokens: r.completion_tokens,
          cost: r.cost,
          costKind: r.cost_kind,
        }
      : null,
    agentId: r.agent_id,
    createdAt: r.created_at,
  };
}

export class Repository {
  constructor(readonly db: DB) {}

  // ---- Conversaciones ----

  listConversations(): Conversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
      .all() as ConversationRow[];
    return rows.map(toConversation);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  createConversation(title = 'Nueva conversación', agentId: string | null = null): Conversation {
    const ts = now();
    const c: Conversation = { id: randomUUID(), title, agentId, createdAt: ts, updatedAt: ts };
    this.db
      .prepare('INSERT INTO conversations (id, title, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, c.title, c.agentId, c.createdAt, c.updatedAt);
    return c;
  }

  setConversationAgent(id: string, agentId: string | null): Conversation | null {
    const res = this.db
      .prepare('UPDATE conversations SET agent_id = ?, updated_at = ? WHERE id = ?')
      .run(agentId, now(), id);
    return res.changes ? this.getConversation(id) : null;
  }

  renameConversation(id: string, title: string): Conversation | null {
    const res = this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now(), id);
    return res.changes ? this.getConversation(id) : null;
  }

  /** Borra la conversación y, por cascada, todos sus mensajes. */
  deleteConversation(id: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
  }

  // ---- Mensajes ----

  listMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conversationId) as MessageRow[];
    return rows.map(toMessage);
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  addMessage(input: {
    conversationId: string;
    role: Message['role'];
    content: string;
    status: Message['status'];
    providerId?: string | null;
    modelId?: string | null;
    agentId?: string | null;
  }): Message {
    const id = randomUUID();
    const ts = now();
    this.db.transaction(() => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?')
        .get(input.conversationId) as { seq: number };
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, provider_id, model_id, agent_id, status, created_at, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.role,
          input.content,
          input.providerId ?? null,
          input.modelId ?? null,
          input.agentId ?? null,
          input.status,
          ts,
          next.seq,
        );
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, input.conversationId);
    })();
    return this.getMessage(id)!;
  }

  /** Guarda el contenido parcial recibido hasta ahora. */
  updateMessageContent(id: string, content: string): void {
    this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  }

  finishMessage(
    id: string,
    result: {
      content: string;
      status: Exclude<Message['status'], 'streaming'>;
      usage?: Usage | null;
      errorKind?: ErrorKind | null;
      errorMessage?: string | null;
    },
  ): Message {
    this.db
      .prepare(
        `UPDATE messages SET content = ?, status = ?, prompt_tokens = ?, completion_tokens = ?, cost = ?, cost_kind = ?,
           error_kind = ?, error_message = ? WHERE id = ?`,
      )
      .run(
        result.content,
        result.status,
        result.usage?.promptTokens ?? null,
        result.usage?.completionTokens ?? null,
        result.usage?.cost ?? null,
        result.usage?.costKind ?? null,
        result.errorKind ?? null,
        result.errorMessage ? redact(result.errorMessage) : null,
        id,
      );
    return this.getMessage(id)!;
  }

  /**
   * Mensajes que quedaron en "streaming" porque la aplicación se cerró.
   * Se marcan como cancelados conservando el texto parcial.
   */
  recoverInterruptedMessages(): number {
    return this.db
      .prepare(
        `UPDATE messages SET status = 'cancelled', error_kind = 'cancelled',
           error_message = 'La respuesta se interrumpió porque la aplicación se cerró.'
         WHERE status = 'streaming'`,
      )
      .run().changes;
  }

  // ---- Agentes ----

  listAgents(): Agent[] {
    const rows = this.db
      .prepare(`${AGENT_SELECT} GROUP BY a.id ORDER BY a.created_at ASC, a.name ASC`)
      .all() as AgentRow[];
    // Primero los iniciales en el orden del equipo; después los personalizados por antigüedad.
    const rank = (r: AgentRow) => {
      const i = DEFAULT_AGENTS.findIndex((d) => d.id === r.id);
      return r.builtin && i >= 0 ? i : DEFAULT_AGENTS.length;
    };
    return rows.sort((a, b) => rank(a) - rank(b)).map(toAgent);
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare(`${AGENT_SELECT} WHERE a.id = ? GROUP BY a.id`).get(id) as AgentRow | undefined;
    return row ? toAgent(row) : null;
  }

  createAgent(input: CreateAgentInput): Agent {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, role, instructions, specialty, provider_id, model_id,
           fallback_provider_id, fallback_model_id, max_output_tokens, temperature, enabled, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description,
        input.role,
        input.instructions,
        input.specialty,
        input.providerId,
        input.modelId,
        input.fallbackProviderId,
        input.fallbackModelId,
        input.maxOutputTokens,
        input.temperature,
        input.enabled ? 1 : 0,
        ts,
        ts,
      );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, input: UpdateAgentInput): Agent | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(AGENT_COLUMNS) as [keyof UpdateAgentInput, string][]) {
      const value = input[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (sets.length === 0) return this.getAgent(id);
    const res = this.db
      .prepare(`UPDATE agents SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, now(), id);
    return res.changes ? this.getAgent(id) : null;
  }

  /** Elimina un agente personalizado. Sus conversaciones y mensajes se conservan sin agente. */
  deleteAgent(id: string): boolean {
    return this.db.prepare('DELETE FROM agents WHERE id = ? AND builtin = 0').run(id).changes > 0;
  }

  /** Crea los agentes iniciales que falten. No modifica los que el usuario ya editó. */
  ensureDefaultAgents(): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, description, role, instructions, specialty, enabled, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    );
    this.db.transaction(() => {
      const ts = now();
      for (const a of DEFAULT_AGENTS) {
        insert.run(a.id, a.name, a.description, a.role, a.instructions, a.specialty ?? null, ts, ts);
      }
    })();
  }

  /** Restaura un agente inicial a sus valores de fábrica. Conserva su historial. */
  resetAgent(id: string): Agent | null {
    const d = findDefaultAgent(id);
    if (!d) return null;
    this.db
      .prepare(
        `UPDATE agents SET name = ?, description = ?, instructions = ?, specialty = ?, provider_id = NULL, model_id = NULL,
           fallback_provider_id = NULL, fallback_model_id = NULL, max_output_tokens = NULL, temperature = NULL,
           enabled = 1, updated_at = ? WHERE id = ?`,
      )
      .run(d.name, d.description, d.instructions, d.specialty ?? null, now(), id);
    return this.getAgent(id);
  }

  // ---- Ajustes, consentimientos y observaciones ----

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  hasConsent(providerId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM provider_consents WHERE provider_id = ?').get(providerId);
  }

  giveConsent(providerId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO provider_consents (provider_id, accepted_at) VALUES (?, ?)')
      .run(providerId, now());
  }

  recordObservation(providerId: string, outcome: { ok: true } | { ok: false; kind: ErrorKind }): void {
    if (outcome.ok) {
      this.db
        .prepare(
          `INSERT INTO provider_observations (provider_id, last_success_at) VALUES (?, ?)
           ON CONFLICT(provider_id) DO UPDATE SET last_success_at = excluded.last_success_at`,
        )
        .run(providerId, now());
    } else {
      this.db
        .prepare(
          `INSERT INTO provider_observations (provider_id, last_error_at, last_error_kind) VALUES (?, ?, ?)
           ON CONFLICT(provider_id) DO UPDATE SET last_error_at = excluded.last_error_at, last_error_kind = excluded.last_error_kind`,
        )
        .run(providerId, now(), outcome.kind);
    }
  }

  getObservation(providerId: string): {
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastErrorKind: ErrorKind | null;
  } {
    const row = this.db.prepare('SELECT * FROM provider_observations WHERE provider_id = ?').get(providerId) as
      | { last_success_at: string | null; last_error_at: string | null; last_error_kind: ErrorKind | null }
      | undefined;
    return {
      lastSuccessAt: row?.last_success_at ?? null,
      lastErrorAt: row?.last_error_at ?? null,
      lastErrorKind: row?.last_error_kind ?? null,
    };
  }

  /**
   * Elimina todos los datos locales (no toca el esquema ni las migraciones).
   * Los agentes vuelven a su estado inicial.
   */
  deleteAllData(): void {
    this.db.transaction(() => {
      for (const table of [
        'task_runs',
        'plans',
        'tasks',
        'messages',
        'conversations',
        'agents',
        'settings',
        'provider_consents',
        'provider_observations',
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    })();
    this.ensureDefaultAgents();
  }
}
