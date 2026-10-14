import type { ComplexityLevel, ExecutionLimits, ReviewLevel } from '../../shared/schemas.js';

/**
 * Estimación de complejidad por reglas (prompt maestro, sección 9). Es
 * independiente del modelo: el Coordinador propone un nivel, la aplicación
 * muestra ambos y el usuario puede fijar el definitivo.
 */
const CRITICAL = [
  'arquitectura',
  'seguridad',
  'vulnerab',
  'migraci',
  'refactor',
  'distribuid',
  'escalab',
  'microservicio',
  'concurrencia',
  'producción',
  'produccion',
  'crític',
  'critic',
  'auditor',
  'rendimiento',
  'infraestructura',
  'despliegue',
];

const INTERMEDIATE = [
  'depur',
  'debug',
  'error',
  'optimiz',
  'compar',
  'diseñ',
  'disen',
  'analiz',
  'análisis',
  'implement',
  'algoritmo',
  'api',
  'integraci',
  'prueba',
  'consulta',
  'modelo de datos',
];

export interface RuleEstimate {
  level: ComplexityLevel;
  reasons: string[];
}

export function estimateComplexity(input: { objective: string; context: string; acceptanceCriteria: string }): RuleEstimate {
  const text = `${input.objective}\n${input.context}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const critical = CRITICAL.filter((k) => text.includes(k));
  if (critical.length) {
    score += 2;
    reasons.push(`Menciona temas de nivel crítico (${critical.slice(0, 3).join(', ')}).`);
  }
  const intermediate = INTERMEDIATE.filter((k) => text.includes(k));
  if (intermediate.length) {
    score += 1;
    reasons.push(`Menciona trabajo técnico de nivel intermedio (${intermediate.slice(0, 3).join(', ')}).`);
  }
  if (text.length > 1_500) {
    score += 1;
    reasons.push('El objetivo y el contexto son extensos.');
  }
  const criteria = input.acceptanceCriteria.split('\n').filter((l) => l.trim()).length;
  if (criteria > 3) {
    score += 1;
    reasons.push(`Tiene ${criteria} criterios de aceptación.`);
  }

  const level: ComplexityLevel = score >= 3 ? 3 : score >= 1 ? 2 : 1;
  if (reasons.length === 0) reasons.push('No se detectaron señales de complejidad.');
  return { level, reasons };
}

const ROUNDS: Record<ComplexityLevel, number> = { 1: 1, 2: 2, 3: 3 };
const HARD_MAX_CALLS = 20;

/**
 * Límites de ejecución fijados por el servidor. Cubren cada subtarea, la
 * revisión por ronda, las correcciones entre rondas y la síntesis.
 */
export function executionLimits(level: ComplexityLevel, subtasks: number, review: ReviewLevel): ExecutionLimits {
  const maxRounds = review === 'none' ? 1 : ROUNDS[level];
  const reviewCalls = review === 'none' ? 0 : maxRounds;
  const corrections = maxRounds - 1;
  const synthesis = subtasks > 1 ? 1 : 0;
  return {
    maxRounds,
    maxCalls: Math.min(HARD_MAX_CALLS, subtasks + reviewCalls + corrections + synthesis),
    costMode: 'free',
  };
}
