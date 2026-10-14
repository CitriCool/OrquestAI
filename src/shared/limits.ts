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
} as const;
