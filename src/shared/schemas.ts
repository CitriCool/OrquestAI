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

export const apiErrorSchema = z.object({
  error: z.object({
    kind: errorKindSchema,
    message: z.string(),
    action: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
