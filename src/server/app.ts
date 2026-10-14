import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  consentInput,
  createConversationInput,
  sendMessageInput,
  updateConversationInput,
  type ProviderStatus,
} from '../shared/schemas.js';
import { ChatService } from './chat/chatService.js';
import { apiError, HttpError, parseJson } from './http.js';
import type { ProviderRegistry } from './providers/registry.js';
import { ProviderError } from './providers/types.js';
import { localGuard } from './security/localGuard.js';
import { log } from './security/redact.js';
import type { Repository } from './storage/repository.js';

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

export function createApp(deps: AppDeps) {
  const { repo, providers } = deps;
  const chat = new ChatService(repo, providers, deps.providerTimeoutMs);
  const api = new Hono();

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
    return c.json({ conversation: repo.createConversation(input.title) }, 201);
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
    const conversation = repo.renameConversation(c.req.param('id'), input.title);
    if (!conversation) throw notFound();
    return c.json({ conversation });
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
    repo.deleteAllData();
    return c.json({ deleted: true });
  });

  const app = new Hono();
  app.route('/api', api);
  return app;
}

function notFound() {
  return new HttpError(404, 'invalid_request', 'La conversación no existe.', 'Vuelve a la lista de conversaciones.');
}
