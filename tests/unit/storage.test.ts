import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../src/server/storage/db.js';
import { migrations } from '../../src/server/storage/migrations.js';
import { Repository } from '../../src/server/storage/repository.js';

describe('persistencia SQLite', () => {
  it('aplica las migraciones una sola vez', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db, migrations)).toEqual([]);
    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([{ version: 1 }]);
  });

  it('borrar una conversación elimina sus mensajes (integridad referencial)', () => {
    const repo = new Repository(openDatabase(':memory:'));
    const c = repo.createConversation();
    repo.addMessage({ conversationId: c.id, role: 'user', content: 'hola', status: 'complete' });
    repo.deleteConversation(c.id);
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('rechaza mensajes de conversaciones inexistentes', () => {
    const repo = new Repository(openDatabase(':memory:'));
    expect(() => repo.addMessage({ conversationId: 'no-existe', role: 'user', content: 'x', status: 'complete' })).toThrow();
  });

  it('los datos persisten al reabrir y las respuestas interrumpidas se recuperan con su texto parcial', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orquestai-'));
    try {
      const file = path.join(dir, 'test.db');
      const repo1 = new Repository(openDatabase(file));
      const c = repo1.createConversation('Persistente');
      const m = repo1.addMessage({ conversationId: c.id, role: 'assistant', content: '', status: 'streaming' });
      repo1.updateMessageContent(m.id, 'texto parcial');
      repo1.db.close();

      const repo2 = new Repository(openDatabase(file));
      expect(repo2.getConversation(c.id)?.title).toBe('Persistente');
      expect(repo2.recoverInterruptedMessages()).toBe(1);
      const recovered = repo2.getMessage(m.id)!;
      expect(recovered.status).toBe('cancelled');
      expect(recovered.content).toBe('texto parcial');
      repo2.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
