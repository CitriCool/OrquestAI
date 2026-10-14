import { describe, expect, it } from 'vitest';
import { estimateComplexity, executionLimits } from '../../src/server/tasks/complexity.js';
import { executionOrder, extractJson, parsePlan } from '../../src/server/tasks/planParser.js';
import type { PlanContent } from '../../src/shared/schemas.js';

const AGENTS = ['desarrollador', 'arquitecto', 'tutor'];

function plan(over: Partial<PlanContent> = {}): PlanContent {
  return {
    interpretedObjective: 'Diseñar una API',
    complexity: { level: 2, justification: 'Varias piezas.' },
    acceptanceCriteria: ['Documentada'],
    subtasks: [
      { id: 's1', title: 'Diseño', description: 'Diseñar', agentId: 'arquitecto', dependsOn: [], expectedOutput: 'Diseño' },
      { id: 's2', title: 'Código', description: 'Programar', agentId: 'desarrollador', dependsOn: ['s1'], expectedOutput: 'Código' },
    ],
    reviewStrategy: 'Revisión crítica',
    completionConditions: ['Criterios cumplidos'],
    assumptions: [],
    questions: [],
    ...over,
  };
}

describe('estimación de complejidad por reglas', () => {
  it('distingue los tres niveles', () => {
    expect(estimateComplexity({ objective: '¿Qué es un índice?', context: '', acceptanceCriteria: '' }).level).toBe(1);
    expect(estimateComplexity({ objective: 'Depurar una consulta SQL', context: '', acceptanceCriteria: '' }).level).toBe(2);
    const critical = estimateComplexity({
      objective: 'Revisar la arquitectura y la seguridad del despliegue',
      context: 'Hay que optimizar el rendimiento',
      acceptanceCriteria: '',
    });
    expect(critical.level).toBe(3);
    expect(critical.reasons.length).toBeGreaterThan(0);
  });
});

describe('límites de ejecución', () => {
  it('dependen del nivel, las subtareas y la revisión, con un máximo fijo', () => {
    expect(executionLimits(1, 1, 'standard')).toEqual({ maxRounds: 1, maxCalls: 2, costMode: 'free' });
    expect(executionLimits(3, 3, 'strict')).toEqual({ maxRounds: 3, maxCalls: 9, costMode: 'free' });
    expect(executionLimits(3, 8, 'none').maxRounds).toBe(1);
    expect(executionLimits(3, 8, 'strict').maxCalls).toBeLessThanOrEqual(20);
  });
});

describe('validación del plan', () => {
  it('extrae el JSON aunque venga en un bloque de código o con texto alrededor', () => {
    expect(extractJson('Claro:\n```json\n{"a":1}\n```\nListo')).toEqual({ a: 1 });
    expect(extractJson('Plan: {"a":{"b":2}} fin')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('sin json')).toThrow(/no contiene/);
  });

  it('acepta un plan correcto y calcula el orden de ejecución', () => {
    const result = parsePlan(JSON.stringify(plan()), AGENTS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(executionOrder(result.content)).toEqual(['s1', 's2']);
  });

  it('rechaza esquemas incompletos con el campo exacto', () => {
    const result = parsePlan(JSON.stringify({ ...plan(), complexity: { level: 5, justification: 'x' } }), AGENTS);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/complexity\.level/);
  });

  it('rechaza agentes no disponibles, dependencias inexistentes e ids repetidos', () => {
    const bad = plan({
      subtasks: [
        { id: 's1', title: 'A', description: 'A', agentId: 'revisor', dependsOn: ['s9'], expectedOutput: 'A' },
        { id: 's1', title: 'B', description: 'B', agentId: 'tutor', dependsOn: [], expectedOutput: 'B' },
      ],
    });
    const result = parsePlan(JSON.stringify(bad), AGENTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.errors.join(' ');
      expect(text).toMatch(/repetidos: s1/);
      expect(text).toMatch(/revisor/);
      expect(text).toMatch(/s9/);
    }
  });

  it('rechaza dependencias circulares', () => {
    const cyclic = plan({
      subtasks: [
        { id: 'a', title: 'A', description: 'A', agentId: 'tutor', dependsOn: ['b'], expectedOutput: 'A' },
        { id: 'b', title: 'B', description: 'B', agentId: 'tutor', dependsOn: ['a'], expectedOutput: 'B' },
      ],
    });
    const result = parsePlan(JSON.stringify(cyclic), AGENTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/ciclo/);
  });
});
