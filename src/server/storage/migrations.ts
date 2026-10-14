/**
 * Migraciones versionadas. Nunca se modifica una migración ya publicada:
 * los cambios se añaden como una versión nueva.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'nucleo_conversaciones',
    sql: `
      CREATE TABLE conversations (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE messages (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content           TEXT NOT NULL,
        provider_id       TEXT,
        model_id          TEXT,
        status            TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'cancelled', 'error')),
        error_kind        TEXT,
        error_message     TEXT,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        cost              REAL,
        cost_kind         TEXT CHECK (cost_kind IN ('estimated', 'reported', 'unknown')),
        created_at        TEXT NOT NULL,
        seq               INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, seq);

      -- Configuración NO secreta. Las claves API nunca se guardan aquí.
      CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );

      -- Aviso aceptado antes de enviar contenido a un proveedor externo.
      CREATE TABLE provider_consents (
        provider_id  TEXT PRIMARY KEY,
        accepted_at  TEXT NOT NULL
      );

      -- Disponibilidad observada (histórica, no es garantía).
      CREATE TABLE provider_observations (
        provider_id      TEXT PRIMARY KEY,
        last_success_at  TEXT,
        last_error_at    TEXT,
        last_error_kind  TEXT
      );
    `,
  },
];
