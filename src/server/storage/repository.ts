import { randomUUID } from 'node:crypto';
import type { Conversation, ErrorKind, Message, Usage } from '../../shared/schemas.js';
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
  created_at: string;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

function toConversation(r: ConversationRow): Conversation {
  return { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
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

  createConversation(title = 'Nueva conversación'): Conversation {
    const ts = now();
    const c: Conversation = { id: randomUUID(), title, createdAt: ts, updatedAt: ts };
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(c.id, c.title, c.createdAt, c.updatedAt);
    return c;
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
  }): Message {
    const id = randomUUID();
    const ts = now();
    this.db.transaction(() => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?')
        .get(input.conversationId) as { seq: number };
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, provider_id, model_id, status, created_at, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.role,
          input.content,
          input.providerId ?? null,
          input.modelId ?? null,
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

  /** Elimina todos los datos locales (no toca el esquema ni las migraciones). */
  deleteAllData(): void {
    this.db.transaction(() => {
      for (const table of ['messages', 'conversations', 'settings', 'provider_consents', 'provider_observations']) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    })();
  }
}
