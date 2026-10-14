import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../src/server/storage/db.js';
import { migrations } from '../../src/server/storage/migrations.js';
import { Repository } from '../../src/server/storage/repository.js';
import { TaskRepository } from '../../src/server/storage/taskRepository.js';

describe('persistencia SQLite', () => {
  it('aplica las migraciones una sola vez', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db, migrations)).toEqual([]);
    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  it('borrar una conversación elimina sus mensajes (integridad referencial)', () => {
    const repo = new Repository(openDatabase(':memory:'));
    const c = repo.createConversation();
    repo.addMessage({ conversationId: c.id, role: 'user', content: 'hola', status: 'complete' });
    repo.deleteConversation(c.id);
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('migra una base de la Fase 1 sin perder datos', () => {
    const db = openDatabase(':memory:', migrations.filter((m) => m.version === 1));
    const old = new Date().toISOString();
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Antigua', old, old);
    expect(migrate(db, migrations)).toEqual([2, 3]);
    const repo = new Repository(db);
    expect(repo.getConversation('c1')).toMatchObject({ title: 'Antigua', agentId: null });
  });

  it('crea los agentes iniciales una sola vez y conserva las ediciones', () => {
    const repo = new Repository(openDatabase(':memory:'));
    repo.ensureDefaultAgents();
    expect(repo.listAgents().map((a) => a.id)).toEqual([
      'coordinador',
      'desarrollador',
      'arquitecto',
      'revisor',
      'especialista',
      'tutor',
      'sintetizador',
    ]);
    repo.updateAgent('tutor', { instructions: 'Explica con analogías.', enabled: false });
    repo.ensureDefaultAgents();
    expect(repo.listAgents()).toHaveLength(7);
    expect(repo.getAgent('tutor')).toMatchObject({ instructions: 'Explica con analogías.', enabled: false });
    expect(repo.resetAgent('tutor')).toMatchObject({ enabled: true, name: 'Tutor' });
    expect(repo.getAgent('tutor')!.instructions).not.toBe('Explica con analogías.');
  });

  it('al eliminar un agente personalizado sus conversaciones y mensajes se conservan sin agente', () => {
    const repo = new Repository(openDatabase(':memory:'));
    const a = repo.createAgent({
      name: 'Redes',
      description: '',
      role: 'specialist',
      instructions: 'Experto en redes.',
      specialty: 'Redes',
      providerId: null,
      modelId: null,
      fallbackProviderId: null,
      fallbackModelId: null,
      maxOutputTokens: null,
      temperature: null,
      enabled: true,
    });
    const c = repo.createConversation('Con agente', a.id);
    repo.addMessage({ conversationId: c.id, role: 'assistant', content: 'hola', status: 'complete', agentId: a.id });
    expect(repo.getAgent(a.id)!.runs).toBe(1);
    expect(repo.deleteAgent(a.id)).toBe(true);
    expect(repo.getConversation(c.id)!.agentId).toBeNull();
    expect(repo.listMessages(c.id)[0]!.agentId).toBeNull();
  });

  it('al reiniciar, una planificación interrumpida vuelve a su plan vigente o queda fallida', () => {
    const db = openDatabase(':memory:');
    new Repository(db).ensureDefaultAgents();
    const tasks = new TaskRepository(db);
    const input = { objective: 'x', context: '', acceptanceCriteria: '', reviewLevel: 'standard' as const, complexityOverride: null };
    const withPlan = tasks.createTask({ ...input, title: 'Con plan' });
    tasks.addPlan({
      taskId: withPlan.id,
      status: 'proposed',
      content: null,
      rawOutput: null,
      validationErrors: [],
      ruleComplexity: 1,
      limits: null,
      feedback: null,
      providerId: 'simulado',
      modelId: 'simulado-basico',
    });
    const without = tasks.createTask({ ...input, title: 'Sin plan' });
    tasks.setTaskStatus(withPlan.id, 'planning');
    tasks.setTaskStatus(without.id, 'planning');
    const run = tasks.startRun({ taskId: without.id, agentId: 'coordinador', kind: 'plan', providerId: 'simulado', modelId: 'm' });

    expect(tasks.recoverInterruptedTasks()).toBe(2);
    expect(tasks.getTask(withPlan.id)!.status).toBe('plan_ready');
    expect(tasks.getTask(without.id)!.status).toBe('plan_failed');
    expect(tasks.getRun(run.id)!.status).toBe('cancelled');
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
