import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  consentInput,
  createAgentInput,
  createConversationInput,
  createTaskInput,
  idSchema,
  planTaskInput,
  sendMessageInput,
  updateAgentInput,
  updateConversationInput,
  updateTaskInput,
  type ProviderStatus,
} from '../shared/schemas.js';
import { ChatService, makeTitle } from './chat/chatService.js';
import { apiError, HttpError, parseJson } from './http.js';
import type { ProviderRegistry } from './providers/registry.js';
import { ProviderError } from './providers/types.js';
import { localGuard } from './security/localGuard.js';
import { log } from './security/redact.js';
import type { Repository } from './storage/repository.js';
import { TaskRepository } from './storage/taskRepository.js';
import { executionLimits } from './tasks/complexity.js';
import { PlanningService } from './tasks/planningService.js';

export interface AppDeps {
  repo: Repository;
  providers: ProviderRegistry;
  token: string;
  allowedHosts: Set<string>;
  providerTimeoutMs: number;
}

const settingsInput = z.object({
  defaultProviderId: z.string().min(1).max(64),
  defaultModelId: z.string().min(1).max(200),
});

const deleteAllInput = z.object({ confirm: z.literal('BORRAR') });
const approvePlanInput = z.object({ planId: idSchema });

export function createApp(deps: AppDeps) {
  const { repo, providers } = deps;
  const chat = new ChatService(repo, providers, deps.providerTimeoutMs);
  const tasks = new TaskRepository(repo.db);
  const planning = new PlanningService(repo, tasks, providers, deps.providerTimeoutMs);
  const api = new Hono();
  repo.ensureDefaultAgents();

  /** Un agente solo puede referirse a proveedores existentes y con proveedor y modelo indicados a la vez. */
  const checkAgentModels = (a: {
    providerId?: string | null;
    modelId?: string | null;
    fallbackProviderId?: string | null;
    fallbackModelId?: string | null;
  }) => {
    for (const [p, m, label] of [
      [a.providerId, a.modelId, 'preferido'],
      [a.fallbackProviderId, a.fallbackModelId, 'de respaldo'],
    ] as const) {
      if (p === undefined && m === undefined) continue;
      if (!p !== !m) {
        throw new HttpError(400, 'invalid_request', `Indica proveedor y modelo ${label}, o deja ambos vacíos.`, 'Completa o vacía ambos campos.');
      }
      if (p && !providers.has(p)) {
        throw new HttpError(400, 'config', `El proveedor ${label} indicado no existe.`, 'Elige un proveedor de la lista.');
      }
    }
  };

  const checkAgentExists = (agentId: string | null | undefined) => {
    if (agentId && !repo.getAgent(agentId)) {
      throw new HttpError(404, 'invalid_request', 'El agente no existe.', 'Elige un agente de la lista.');
    }
  };

  api.use('*', localGuard({ hosts: deps.allowedHosts, token: deps.token }));
  api.use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => apiError(c, 413, 'invalid_request', 'La solicitud es demasiado grande.', 'Reduce el tamaño del mensaje.'),
    }),
  );

  api.onError((err, c) => {
    if (err instanceof HttpError) return apiError(c, err.status, err.kind, err.message, err.action);
    if (err instanceof ProviderError) return apiError(c, 502, err.kind, err.message, err.action);
    log.error('Error no controlado en la API.', err);
    return apiError(c, 500, 'unknown', 'Error interno del servidor.', 'Revisa el registro del servidor.');
  });
  api.notFound((c) => apiError(c, 404, 'invalid_request', 'Ruta no encontrada.', 'Revisa la dirección.'));

  // ---- Sesión ----
  api.get('/session', (c) => c.json({ token: deps.token }));
  api.get('/health', (c) => c.json({ ok: true }));

  // ---- Conversaciones ----
  api.get('/conversations', (c) => c.json({ conversations: repo.listConversations() }));

  api.post('/conversations', async (c) => {
    const input = await parseJson(c, createConversationInput);
    checkAgentExists(input.agentId);
    return c.json({ conversation: repo.createConversation(input.title, input.agentId ?? null) }, 201);
  });

  api.get('/conversations/:id', (c) => {
    const conversation = repo.getConversation(c.req.param('id'));
    if (!conversation) throw notFound();
    return c.json({
      conversation: { ...conversation, messages: repo.listMessages(conversation.id) },
      running: chat.isActive(conversation.id),
    });
  });

  api.patch('/conversations/:id', async (c) => {
    const input = await parseJson(c, updateConversationInput);
    const id = c.req.param('id');
    if (!repo.getConversation(id)) throw notFound();
    checkAgentExists(input.agentId);
    if (input.title !== undefined) repo.renameConversation(id, input.title);
    if (input.agentId !== undefined) repo.setConversationAgent(id, input.agentId);
    return c.json({ conversation: repo.getConversation(id) });
  });

  api.delete('/conversations/:id', (c) => {
    const id = c.req.param('id');
    chat.stop(id); // no deja una respuesta en curso escribiendo sobre datos borrados
    if (!repo.deleteConversation(id)) throw notFound();
    return c.json({ deleted: true });
  });

  api.post('/conversations/:id/messages', async (c) => {
    const input = await parseJson(c, sendMessageInput);
    const run = await chat.prepare(c.req.param('id'), input);
    return streamSSE(c, async (stream) => {
      // Las escrituras se encadenan para conservar el orden y esperar a la última antes de cerrar.
      let writes = Promise.resolve();
      await run.start((event) => {
        writes = writes
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => undefined);
      });
      await writes;
    });
  });

  api.post('/conversations/:id/stop', (c) => c.json({ stopped: chat.stop(c.req.param('id')) }));

  // ---- Agentes ----
  api.get('/agents', (c) => c.json({ agents: repo.listAgents() }));

  api.get('/agents/:id', (c) => {
    const agent = repo.getAgent(c.req.param('id'));
    if (!agent) throw agentNotFound();
    return c.json({ agent });
  });

  api.post('/agents', async (c) => {
    const input = await parseJson(c, createAgentInput);
    checkAgentModels(input);
    return c.json({ agent: repo.createAgent(input) }, 201);
  });

  api.patch('/agents/:id', async (c) => {
    const input = await parseJson(c, updateAgentInput);
    const current = repo.getAgent(c.req.param('id'));
    if (!current) throw agentNotFound();
    // Se valida el par resultante, no solo los campos enviados.
    checkAgentModels({
      providerId: input.providerId !== undefined ? input.providerId : current.providerId,
      modelId: input.modelId !== undefined ? input.modelId : current.modelId,
      fallbackProviderId: input.fallbackProviderId !== undefined ? input.fallbackProviderId : current.fallbackProviderId,
      fallbackModelId: input.fallbackModelId !== undefined ? input.fallbackModelId : current.fallbackModelId,
    });
    return c.json({ agent: repo.updateAgent(current.id, input) });
  });

  api.delete('/agents/:id', (c) => {
    const agent = repo.getAgent(c.req.param('id'));
    if (!agent) throw agentNotFound();
    if (agent.builtin) {
      throw new HttpError(409, 'invalid_request', 'Los agentes iniciales no se pueden eliminar.', 'Puedes deshabilitarlo o restaurar sus valores.');
    }
    repo.deleteAgent(agent.id);
    return c.json({ deleted: true });
  });

  api.post('/agents/:id/reset', (c) => {
    const agent = repo.getAgent(c.req.param('id'));
    if (!agent) throw agentNotFound();
    if (!agent.builtin) {
      throw new HttpError(409, 'invalid_request', 'Solo los agentes iniciales tienen valores que restaurar.', 'Edita el agente directamente.');
    }
    return c.json({ agent: repo.resetAgent(agent.id) });
  });

  // ---- Tareas y planes ----
  const taskDetail = (id: string) => {
    const task = tasks.getTaskDetail(id);
    if (!task) throw taskNotFound();
    return { task, planning: planning.isActive(id) };
  };

  api.get('/tasks', (c) => c.json({ tasks: tasks.listTasks() }));

  api.post('/tasks', async (c) => {
    const input = await parseJson(c, createTaskInput);
    const task = tasks.createTask({ ...input, title: input.title ?? makeTitle(input.objective) });
    return c.json({ task }, 201);
  });

  api.get('/tasks/:id', (c) => c.json(taskDetail(c.req.param('id'))));

  api.patch('/tasks/:id', async (c) => {
    const input = await parseJson(c, updateTaskInput);
    const task = tasks.updateTask(c.req.param('id'), input);
    if (!task) throw taskNotFound();
    // Los límites dependen del nivel final: se recalculan en el plan propuesto.
    const plan = tasks.currentPlan(task.id);
    if (input.complexityOverride !== undefined && plan?.status === 'proposed' && plan.content) {
      const level = task.complexityOverride ?? plan.content.complexity.level;
      tasks.updatePlanLimits(plan.id, executionLimits(level, plan.content.subtasks.length, task.reviewLevel));
    }
    return c.json(taskDetail(task.id));
  });

  api.delete('/tasks/:id', (c) => {
    const id = c.req.param('id');
    planning.cancel(id);
    if (!tasks.deleteTask(id)) throw taskNotFound();
    return c.json({ deleted: true });
  });

  api.post('/tasks/:id/plan', async (c) => {
    const input = await parseJson(c, planTaskInput);
    await planning.start(c.req.param('id'), input);
    return c.json(taskDetail(c.req.param('id')), 202);
  });

  /** Detiene la planificación en curso. */
  api.post('/tasks/:id/stop', (c) => c.json({ stopped: planning.cancel(c.req.param('id')) }));

  api.post('/tasks/:id/approve', async (c) => {
    const input = await parseJson(c, approvePlanInput);
    const task = tasks.getTask(c.req.param('id'));
    if (!task) throw taskNotFound();
    const plan = tasks.currentPlan(task.id);
    if (planning.isActive(task.id) || task.status !== 'plan_ready' || plan?.id !== input.planId || plan.status !== 'proposed' || !plan.content) {
      throw new HttpError(409, 'invalid_request', 'Ese plan no se puede aprobar: no es la versión propuesta vigente.', 'Recarga la tarea y revisa el plan actual.');
    }
    const level = task.complexityOverride ?? plan.content.complexity.level;
    tasks.updatePlanLimits(plan.id, executionLimits(level, plan.content.subtasks.length, task.reviewLevel));
    tasks.approvePlan(plan.id);
    tasks.setTaskStatus(task.id, 'approved');
    return c.json(taskDetail(task.id));
  });

  api.post('/tasks/:id/cancel', (c) => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) throw taskNotFound();
    planning.cancel(id);
    tasks.setTaskStatus(id, 'cancelled');
    return c.json(taskDetail(id));
  });

  // ---- Proveedores y modelos ----
  api.get('/providers', (c) => {
    const list: ProviderStatus[] = [...providers.values()].map((p) => {
      const status = p.getProviderStatus();
      return {
        id: p.id,
        label: p.label,
        external: p.external,
        configured: status.configured,
        consentGiven: !p.external || repo.hasConsent(p.id),
        notes: status.notes,
        ...repo.getObservation(p.id),
      };
    });
    return c.json({ providers: list });
  });

  api.get('/providers/:id/models', async (c) => {
    const provider = providers.get(c.req.param('id'));
    if (!provider) throw new HttpError(404, 'config', 'El proveedor no existe.', 'Elige un proveedor de la lista.');
    if (!provider.getProviderStatus().configured) {
      throw new HttpError(400, 'config', `${provider.label} no está configurado.`, provider.getProviderStatus().notes[0] ?? '');
    }
    return c.json({ models: await provider.listModels() });
  });

  api.post('/providers/:id/consent', async (c) => {
    await parseJson(c, consentInput);
    const provider = providers.get(c.req.param('id'));
    if (!provider) throw new HttpError(404, 'config', 'El proveedor no existe.', 'Elige un proveedor de la lista.');
    repo.giveConsent(provider.id);
    return c.json({ consentGiven: true });
  });

  // ---- Ajustes (no secretos) ----
  api.get('/settings', (c) =>
    c.json({
      defaultProviderId: repo.getSetting('defaultProviderId') ?? 'simulado',
      defaultModelId: repo.getSetting('defaultModelId') ?? 'simulado-basico',
    }),
  );

  api.put('/settings', async (c) => {
    const input = await parseJson(c, settingsInput);
    if (!providers.has(input.defaultProviderId)) {
      throw new HttpError(400, 'config', 'El proveedor indicado no existe.', 'Elige un proveedor de la lista.');
    }
    repo.setSetting('defaultProviderId', input.defaultProviderId);
    repo.setSetting('defaultModelId', input.defaultModelId);
    return c.json(input);
  });

  api.delete('/data', async (c) => {
    await parseJson(c, deleteAllInput);
    for (const conv of repo.listConversations()) chat.stop(conv.id);
    for (const task of tasks.listTasks()) planning.cancel(task.id);
    await planning.idle();
    repo.deleteAllData();
    return c.json({ deleted: true });
  });

  const app = new Hono();
  app.route('/api', api);
  return app;
}

function taskNotFound() {
  return new HttpError(404, 'invalid_request', 'La tarea no existe.', 'Vuelve a la lista de tareas.');
}

function agentNotFound() {
  return new HttpError(404, 'invalid_request', 'El agente no existe.', 'Vuelve a la lista de agentes.');
}

function notFound() {
  return new HttpError(404, 'invalid_request', 'La conversación no existe.', 'Vuelve a la lista de conversaciones.');
}
