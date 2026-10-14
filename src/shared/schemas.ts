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
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: idSchema,
  title: z.string(),
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
});

export const updateConversationInput = z.object({
  title: z.string().trim().min(1).max(LIMITS.titleMax),
});

export const sendMessageInput = z.object({
  content: z.string().trim().min(1).max(LIMITS.messageMax),
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(LIMITS.modelIdMax),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const consentInput = z.object({ accepted: z.literal(true) });

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
