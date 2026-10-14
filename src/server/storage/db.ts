import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { migrations as defaultMigrations, type Migration } from './migrations.js';

export type DB = Database.Database;

export function openDatabase(file: string, migrations: Migration[] = defaultMigrations): DB {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations);
  return db;
}

export function migrate(db: DB, migrations: Migration[]): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const done: number[] = [];
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of ordered) {
    if (applied.has(m.version)) continue;
    // Procedimiento de SQLite para reconstruir tablas: claves foráneas desactivadas
    // fuera de la transacción y comprobación de integridad antes de confirmar.
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (m.rebuildsTables) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.rebuildsTables) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length) throw new Error(`La migración ${m.version} dejó ${broken.length} referencia(s) rotas.`);
        }
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString(),
        );
      })();
    } finally {
      if (m.rebuildsTables && fkWasOn) db.pragma('foreign_keys = ON');
    }
    done.push(m.version);
  }
  return done;
}
