/**
 * Migraciones versionadas. Nunca se modifica una migración ya publicada:
 * los cambios se añaden como una versión nueva.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Para reconstruir tablas (SQLite no permite cambiar un CHECK): desactiva
   * las claves foráneas durante la migración y comprueba la integridad al final.
   */
  rebuildsTables?: boolean;
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
  {
    version: 4,
    name: 'ejecucion_de_tareas',
    rebuildsTables: true,
    sql: `
      -- Estados de ejecución y resultado final en las tareas.
      CREATE TABLE tasks_new (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        objective            TEXT NOT NULL,
        context              TEXT NOT NULL DEFAULT '',
        acceptance_criteria  TEXT NOT NULL DEFAULT '',
        review_level         TEXT NOT NULL CHECK (review_level IN ('none', 'standard', 'strict')),
        complexity_override  INTEGER CHECK (complexity_override IN (1, 2, 3)),
        status               TEXT NOT NULL CHECK (status IN ('draft', 'planning', 'plan_ready', 'plan_failed',
                               'approved', 'running', 'completed', 'interrupted', 'failed', 'done', 'cancelled')),
        error_kind           TEXT,
        error_message        TEXT,
        result               TEXT,
        outcome              TEXT CHECK (outcome IN ('complete', 'partial')),
        limitations          TEXT NOT NULL DEFAULT '[]',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      INSERT INTO tasks_new (id, title, objective, context, acceptance_criteria, review_level, complexity_override,
          status, error_kind, error_message, created_at, updated_at)
        SELECT id, title, objective, context, acceptance_criteria, review_level, complexity_override,
          status, error_kind, error_message, created_at, updated_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      -- Cada llamada guarda ahora su etapa, ronda, subtarea y el texto devuelto.
      CREATE TABLE task_runs_new (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        plan_id            TEXT REFERENCES plans(id) ON DELETE SET NULL,
        agent_id           TEXT REFERENCES agents(id) ON DELETE SET NULL,
        kind               TEXT NOT NULL CHECK (kind IN ('plan', 'plan_repair', 'subtask', 'review', 'review_repair',
                             'correction', 'synthesis')),
        execution          INTEGER,
        round              INTEGER,
        subtask_id         TEXT,
        provider_id        TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('running', 'complete', 'error', 'cancelled')),
        output             TEXT,
        review             TEXT,
        error_kind         TEXT,
        error_message      TEXT,
        prompt_tokens      INTEGER,
        completion_tokens  INTEGER,
        cost               REAL,
        cost_kind          TEXT CHECK (cost_kind IN ('estimated', 'reported', 'unknown')),
        started_at         TEXT NOT NULL,
        finished_at        TEXT
      );
      INSERT INTO task_runs_new (id, task_id, plan_id, agent_id, kind, provider_id, model_id, status, error_kind,
          error_message, prompt_tokens, completion_tokens, cost, cost_kind, started_at, finished_at)
        SELECT id, task_id, plan_id, agent_id, kind, provider_id, model_id, status, error_kind,
          error_message, prompt_tokens, completion_tokens, cost, cost_kind, started_at, finished_at FROM task_runs;
      DROP TABLE task_runs;
      ALTER TABLE task_runs_new RENAME TO task_runs;
      CREATE INDEX idx_task_runs_task ON task_runs(task_id, started_at);
      CREATE INDEX idx_task_runs_agent ON task_runs(agent_id);
      CREATE INDEX idx_task_runs_execution ON task_runs(task_id, execution);
    `,
  },
  {
    version: 5,
    name: 'costes_por_tarea',
    sql: `
      ALTER TABLE tasks ADD COLUMN cost_mode TEXT CHECK (cost_mode IN ('free', 'economic', 'manual'));
      ALTER TABLE tasks ADD COLUMN budget_usd REAL CHECK (budget_usd >= 0);
      -- Para sumar el gasto por periodo.
      CREATE INDEX idx_messages_created ON messages(created_at);
      CREATE INDEX idx_task_runs_started ON task_runs(started_at);
    `,
  },
];
