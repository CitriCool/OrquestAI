/** Límites de tamaño aplicados en el servidor y reutilizados en la interfaz. */
export const LIMITS = {
  titleMax: 200,
  messageMax: 50_000,
  modelIdMax: 200,
  agentNameMax: 80,
  agentDescriptionMax: 500,
  agentInstructionsMax: 8_000,
  agentSpecialtyMax: 200,
  agentMaxOutputTokens: 32_000,
  taskObjectiveMax: 4_000,
  taskContextMax: 20_000,
  taskCriteriaMax: 4_000,
  feedbackMax: 4_000,
  /** Un plan con más subtareas se rechaza: conviene dividir la tarea. */
  planMaxSubtasks: 8,
} as const;
