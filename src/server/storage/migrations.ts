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
  {
    version: 2,
    name: 'agentes',
    sql: `
      CREATE TABLE agents (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        role                  TEXT NOT NULL CHECK (role IN ('coordinator', 'developer', 'architect', 'reviewer',
                                'specialist', 'tutor', 'synthesizer', 'custom')),
        instructions          TEXT NOT NULL,
        specialty             TEXT,
        provider_id           TEXT,
        model_id              TEXT,
        fallback_provider_id  TEXT,
        fallback_model_id     TEXT,
        max_output_tokens     INTEGER,
        temperature           REAL,
        enabled               INTEGER NOT NULL DEFAULT 1,
        builtin               INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );

      -- Agente de la conversación (null = asistente general) y agente que generó cada respuesta.
      ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
      CREATE INDEX idx_messages_agent ON messages(agent_id);
    `,
  },
  {
    version: 3,
    name: 'tareas_y_planes',
    sql: `
      CREATE TABLE tasks (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        objective            TEXT NOT NULL,
        context              TEXT NOT NULL DEFAULT '',
        acceptance_criteria  TEXT NOT NULL DEFAULT '',
        review_level         TEXT NOT NULL CHECK (review_level IN ('none', 'standard', 'strict')),
        complexity_override  INTEGER CHECK (complexity_override IN (1, 2, 3)),
        status               TEXT NOT NULL CHECK (status IN ('draft', 'planning', 'plan_ready', 'plan_failed',
                               'approved', 'cancelled')),
        error_kind           TEXT,
        error_message        TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      -- Versiones del plan. Se guardan antes de ejecutar cualquier subtarea.
      CREATE TABLE plans (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        version            INTEGER NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'superseded', 'invalid')),
        content            TEXT,
        raw_output         TEXT,
        validation_errors  TEXT NOT NULL DEFAULT '[]',
        rule_complexity    INTEGER NOT NULL CHECK (rule_complexity IN (1, 2, 3)),
        limits             TEXT,
        feedback           TEXT,
        provider_id        TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        approved_at        TEXT,
        UNIQUE (task_id, version)
      );

      -- Cada llamada a un modelo dentro de una tarea.
      CREATE TABLE task_runs (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        plan_id            TEXT REFERENCES plans(id) ON DELETE SET NULL,
        agent_id           TEXT REFERENCES agents(id) ON DELETE SET NULL,
        kind               TEXT NOT NULL CHECK (kind IN ('plan', 'plan_repair')),
        provider_id        TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('running', 'complete', 'error', 'cancelled')),
        error_kind         TEXT,
        error_message      TEXT,
        prompt_tokens      INTEGER,
        completion_tokens  INTEGER,
        cost               REAL,
        cost_kind          TEXT CHECK (cost_kind IN ('estimated', 'reported', 'unknown')),
        started_at         TEXT NOT NULL,
        finished_at        TEXT
      );
      CREATE INDEX idx_task_runs_task ON task_runs(task_id, started_at);
      CREATE INDEX idx_task_runs_agent ON task_runs(agent_id);
    `,
  },
];
