import { z } from 'zod';

import { LIMITS } from './limits.js';

export { LIMITS };

export const idSchema = z.string().min(1).max(64);

export const costClassSchema = z.enum(['free', 'low', 'standard', 'premium', 'unknown']);
export type CostClass = z.infer<typeof costClassSchema>;

/** Naturaleza de un importe: nunca se presenta una estimación como coste real. */
export const costKindSchema = z.enum(['estimated', 'reported', 'unknown']);
export type CostKind = z.infer<typeof costKindSchema>;

export const messageRoleSchema = z.enum(['user', 'assistant']);
export const messageStatusSchema = z.enum(['complete', 'streaming', 'cancelled', 'error']);

export const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  cost: z.number().nonnegative().nullable(),
  costKind: costKindSchema,
});
export type Usage = z.infer<typeof usageSchema>;

export const errorKindSchema = z.enum([
  'rate_limit',
  'server',
  'timeout',
  'network',
  'auth',
  'forbidden',
  'model_unavailable',
  'invalid_request',
  'config',
  'cancelled',
  'policy',
  'unknown',
]);
export type ErrorKind = z.infer<typeof errorKindSchema>;

export const messageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  role: messageRoleSchema,
  content: z.string(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  status: messageStatusSchema,
  errorKind: errorKindSchema.nullable(),
  errorMessage: z.string().nullable(),
  usage: usageSchema.nullable(),
  /** Agente que respondió (solo en mensajes del asistente). */
  agentId: z.string().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: idSchema,
  title: z.string(),
  /** Agente con el que se conversa; null = asistente general. */
  agentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationDetailSchema = conversationSchema.extend({
  messages: z.array(messageSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

// ---- Entradas de la API ----

export const createConversationInput = z.object({
  title: z.string().trim().min(1).max(LIMITS.titleMax).optional(),
  agentId: idSchema.nullable().optional(),
});

export const updateConversationInput = z
  .object({
    title: z.string().trim().min(1).max(LIMITS.titleMax).optional(),
    agentId: idSchema.nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.agentId !== undefined, { message: 'Indica title o agentId.' });

export const sendMessageInput = z.object({
  content: z.string().trim().min(1).max(LIMITS.messageMax),
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(LIMITS.modelIdMax),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const consentInput = z.object({ accepted: z.literal(true) });

// ---- Agentes ----

export const agentRoleSchema = z.enum([
  'coordinator',
  'developer',
  'architect',
  'reviewer',
  'specialist',
  'tutor',
  'synthesizer',
  'custom',
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const agentSchema = z.object({
  /** Identificador estable: no cambia al renombrar el agente. */
  id: idSchema,
  name: z.string(),
  description: z.string(),
  role: agentRoleSchema,
  /** Instrucciones del agente; se envían separadas de los datos de la tarea. */
  instructions: z.string(),
  specialty: z.string().nullable(),
  /** Modelo preferido; null = el predeterminado de la aplicación. */
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Respaldo opcional. Se guarda ahora y se usa en la Fase 4 (transferencia y recuperación). */
  fallbackProviderId: z.string().nullable(),
  fallbackModelId: z.string().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  enabled: z.boolean(),
  /** Agente inicial de la aplicación: se puede editar y restaurar, pero no eliminar. */
  builtin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Historial de ejecuciones: respuestas generadas por este agente. */
  runs: z.number().int().nonnegative(),
  lastRunAt: z.string().nullable(),
});
export type Agent = z.infer<typeof agentSchema>;

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

const agentFields = {
  name: z.string().trim().min(1).max(LIMITS.agentNameMax),
  description: z.string().trim().max(LIMITS.agentDescriptionMax),
  instructions: z.string().trim().min(1).max(LIMITS.agentInstructionsMax),
  specialty: nullableText(LIMITS.agentSpecialtyMax),
  providerId: z.string().min(1).max(64).nullable(),
  modelId: z.string().min(1).max(LIMITS.modelIdMax).nullable(),
  fallbackProviderId: z.string().min(1).max(64).nullable(),
  fallbackModelId: z.string().min(1).max(LIMITS.modelIdMax).nullable(),
  maxOutputTokens: z.number().int().min(1).max(LIMITS.agentMaxOutputTokens).nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  enabled: z.boolean(),
};

/** Solo se crean agentes especialistas o personalizados; los demás roles ya existen y son únicos. */
export const createAgentInput = z.object({
  ...agentFields,
  role: z.enum(['specialist', 'custom']).default('custom'),
  description: agentFields.description.default(''),
  specialty: agentFields.specialty.optional().default(null),
  providerId: agentFields.providerId.optional().default(null),
  modelId: agentFields.modelId.optional().default(null),
  fallbackProviderId: agentFields.fallbackProviderId.optional().default(null),
  fallbackModelId: agentFields.fallbackModelId.optional().default(null),
  maxOutputTokens: agentFields.maxOutputTokens.optional().default(null),
  temperature: agentFields.temperature.optional().default(null),
  enabled: agentFields.enabled.default(true),
});
export type CreateAgentInput = z.infer<typeof createAgentInput>;

/** Actualización parcial. El rol y el identificador no se cambian. */
export const updateAgentInput = z.object(agentFields).partial();
export type UpdateAgentInput = z.infer<typeof updateAgentInput>;

// ---- Proveedores y modelos ----

export const modelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  costClass: costClassSchema,
  /** De dónde sale la clasificación de coste. */
  costSource: z.string(),
  contextLength: z.number().int().positive().nullable(),
  verifiedAt: z.string().nullable(),
  /** Si existe, el modelo no se puede usar desde esta aplicación y el motivo se muestra al usuario. */
  restriction: z.string().nullable().optional(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const providerStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  external: z.boolean(),
  configured: z.boolean(),
  consentGiven: z.boolean(),
  notes: z.array(z.string()),
  lastSuccessAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastErrorKind: errorKindSchema.nullable(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

// ---- Eventos del flujo de chat (SSE) ----

export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), message: messageSchema }),
  z.object({ type: z.literal('assistant_start'), message: messageSchema }),
  z.object({ type: z.literal('delta'), messageId: idSchema, text: z.string() }),
  z.object({ type: z.literal('assistant_end'), message: messageSchema }),
  z.object({
    type: z.literal('error'),
    kind: errorKindSchema,
    message: z.string(),
    action: z.string(),
  }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

// ---- Tareas y planes (Fase 2) ----

export const complexityLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type ComplexityLevel = z.infer<typeof complexityLevelSchema>;

export const reviewLevelSchema = z.enum(['none', 'standard', 'strict']);
export type ReviewLevel = z.infer<typeof reviewLevelSchema>;

/**
 * Estados de una tarea. En el Sprint 2.2 una tarea llega hasta «approved»;
 * la ejecución de subtareas se añade en el Sprint 2.3.
 */
export const taskStatusSchema = z.enum(['draft', 'planning', 'plan_ready', 'plan_failed', 'approved', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Subtarea tal como la propone el Coordinador. */
export const planSubtaskSchema = z.object({
  id: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  agentId: z.string().trim().min(1).max(64),
  dependsOn: z.array(z.string().trim().min(1).max(40)).max(LIMITS.planMaxSubtasks).default([]),
  expectedOutput: z.string().trim().min(1).max(1_000),
});
export type PlanSubtask = z.infer<typeof planSubtaskSchema>;

/** Contenido del plan que debe devolver el Coordinador, en JSON. */
export const planContentSchema = z.object({
  interpretedObjective: z.string().trim().min(1).max(2_000),
  complexity: z.object({
    level: complexityLevelSchema,
    justification: z.string().trim().min(1).max(1_000),
  }),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  subtasks: z.array(planSubtaskSchema).min(1).max(LIMITS.planMaxSubtasks),
  reviewStrategy: z.string().trim().min(1).max(1_000),
  completionConditions: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  questions: z.array(z.string().trim().min(1).max(500)).max(6).default([]),
});
export type PlanContent = z.infer<typeof planContentSchema>;

/** Límites de ejecución que fija el servidor (no el modelo) según la complejidad. */
export const executionLimitsSchema = z.object({
  maxRounds: z.number().int().positive(),
  maxCalls: z.number().int().positive(),
  costMode: z.literal('free'),
});
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;

export const planStatusSchema = z.enum(['proposed', 'approved', 'superseded', 'invalid']);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  version: z.number().int().positive(),
  status: planStatusSchema,
  /** null si el Coordinador no produjo un plan válido. */
  content: planContentSchema.nullable(),
  /** Errores de validación del último intento (vacío si es válido). */
  validationErrors: z.array(z.string()),
  /** Estimación por reglas, independiente del modelo. */
  ruleComplexity: complexityLevelSchema,
  limits: executionLimitsSchema.nullable(),
  /** Comentarios del usuario que motivaron esta versión. */
  feedback: z.string().nullable(),
  providerId: z.string(),
  modelId: z.string(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
});
export type Plan = z.infer<typeof planSchema>;

export const taskRunKindSchema = z.enum(['plan', 'plan_repair']);
export const taskRunStatusSchema = z.enum(['running', 'complete', 'error', 'cancelled']);

/** Cada llamada a un modelo dentro de una tarea, para el historial y el control de llamadas. */
export const taskRunSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  planId: z.string().nullable(),
  agentId: z.string().nullable(),
  kind: taskRunKindSchema,
  providerId: z.string(),
  modelId: z.string(),
  status: taskRunStatusSchema,
  errorKind: errorKindSchema.nullable(),
  errorMessage: z.string().nullable(),
  usage: usageSchema.nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type TaskRun = z.infer<typeof taskRunSchema>;

export const taskSchema = z.object({
  id: idSchema,
  title: z.string(),
  objective: z.string(),
  context: z.string(),
  acceptanceCriteria: z.string(),
  reviewLevel: reviewLevelSchema,
  /** Nivel fijado por el usuario; tiene prioridad sobre el del plan. */
  complexityOverride: complexityLevelSchema.nullable(),
  status: taskStatusSchema,
  errorKind: errorKindSchema.nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskDetailSchema = taskSchema.extend({
  plans: z.array(planSchema),
  runs: z.array(taskRunSchema),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const createTaskInput = z.object({
  title: z.string().trim().min(1).max(LIMITS.titleMax).optional(),
  objective: z.string().trim().min(1).max(LIMITS.taskObjectiveMax),
  context: z.string().trim().max(LIMITS.taskContextMax).default(''),
  acceptanceCriteria: z.string().trim().max(LIMITS.taskCriteriaMax).default(''),
  reviewLevel: reviewLevelSchema.default('standard'),
  complexityOverride: complexityLevelSchema.nullable().default(null),
});
export type CreateTaskInput = z.infer<typeof createTaskInput>;

/** Pide un plan (o una versión nueva) con el modelo indicado. */
export const planTaskInput = z.object({
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(LIMITS.modelIdMax),
  feedback: z.string().trim().max(LIMITS.feedbackMax).optional(),
});
export type PlanTaskInput = z.infer<typeof planTaskInput>;

export const updateTaskInput = z
  .object({
    title: z.string().trim().min(1).max(LIMITS.titleMax).optional(),
    complexityOverride: complexityLevelSchema.nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.complexityOverride !== undefined, {
    message: 'Indica title o complexityOverride.',
  });

export const apiErrorSchema = z.object({
  error: z.object({
    kind: errorKindSchema,
    message: z.string(),
    action: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
