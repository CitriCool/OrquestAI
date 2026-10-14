import type { ChatEvent, Message, SendMessageInput } from '../../shared/schemas.js';
import { HttpError } from '../http.js';
import { assertModelAllowed } from '../policies/modelPolicy.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ProviderError, type ChatTurn, type ProviderAdapter } from '../providers/types.js';
import { log } from '../security/redact.js';
import type { Repository } from '../storage/repository.js';

const SYSTEM_PROMPT =
  'Eres un asistente técnico para Ingeniería Civil Informática. Responde en español, con precisión, ' +
  'indicando supuestos y limitaciones. Si no sabes algo, dilo.';

/** Contexto enviado por llamada: no se envía todo el historial indiscriminadamente. */
const CONTEXT_MAX_MESSAGES = 20;
const CONTEXT_MAX_CHARS = 24_000;
const DEFAULT_TITLE = 'Nueva conversación';
const PERSIST_EVERY_MS = 1_000;

export interface ChatRun {
  start(emit: (event: ChatEvent) => void): Promise<void>;
}

export class ChatService {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly repo: Repository,
    private readonly providers: ProviderRegistry,
    private readonly timeoutMs: number,
  ) {}

  isActive(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  /**
   * Comprobaciones previas (fallan con HttpError antes de abrir el stream)
   * y reserva de la conversación para evitar dos respuestas simultáneas.
   */
  async prepare(conversationId: string, input: SendMessageInput): Promise<ChatRun> {
    const conversation = this.repo.getConversation(conversationId);
    if (!conversation) throw new HttpError(404, 'invalid_request', 'La conversación no existe.', 'Vuelve a la lista de conversaciones.');
    if (this.active.has(conversationId)) {
      throw new HttpError(409, 'invalid_request', 'Ya hay una respuesta en curso en esta conversación.', 'Espera a que termine o pulsa Detener.');
    }
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new HttpError(400, 'config', 'El proveedor indicado no existe.', 'Elige un proveedor de la lista.');
    const status = provider.getProviderStatus();
    if (!status.configured) {
      throw new HttpError(400, 'config', `${provider.label} no está configurado.`, status.notes[0] ?? 'Revisa el archivo .env.');
    }
    if (provider.external && !this.repo.hasConsent(provider.id)) {
      throw new HttpError(
        409,
        'policy',
        `Antes de enviar contenido a ${provider.label} debes aceptar el aviso de envío a un proveedor externo.`,
        'Acepta el aviso en Modelos y proveedores.',
      );
    }

    // Reserva antes de cualquier espera para que una segunda petición simultánea se rechace.
    const controller = new AbortController();
    this.active.set(conversationId, controller);
    try {
      await assertModelAllowed(provider, input.modelId);
    } catch (err) {
      this.active.delete(conversationId);
      throw err;
    }

    return {
      start: (emit) => this.run(conversationId, conversation.title, input, provider, controller, emit),
    };
  }

  /** Detiene la respuesta en curso. La parte ya recibida se conserva. */
  stop(conversationId: string): boolean {
    const controller = this.active.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async run(
    conversationId: string,
    title: string,
    input: SendMessageInput,
    provider: ProviderAdapter,
    controller: AbortController,
    emit: (event: ChatEvent) => void,
  ): Promise<void> {
    const safeEmit = (event: ChatEvent) => {
      try {
        emit(event);
      } catch {
        // El cliente se desconectó: la respuesta sigue guardándose.
      }
    };

    try {
      const history = this.repo.listMessages(conversationId);
      const userMessage = this.repo.addMessage({
        conversationId,
        role: 'user',
        content: input.content,
        status: 'complete',
      });
      if (title === DEFAULT_TITLE && history.length === 0) {
        this.repo.renameConversation(conversationId, makeTitle(input.content));
      }
      safeEmit({ type: 'user_message', message: userMessage });

      const assistant = this.repo.addMessage({
        conversationId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        providerId: provider.id,
        modelId: input.modelId,
      });
      safeEmit({ type: 'assistant_start', message: assistant });

      let text = '';
      let lastPersist = Date.now();
      try {
        const response = await provider.generateResponse({
          modelId: input.modelId,
          messages: buildContext([...history, userMessage]),
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
          onDelta: (piece) => {
            text += piece;
            safeEmit({ type: 'delta', messageId: assistant.id, text: piece });
            if (Date.now() - lastPersist >= PERSIST_EVERY_MS && this.repo.getMessage(assistant.id)) {
              this.repo.updateMessageContent(assistant.id, text);
              lastPersist = Date.now();
            }
          },
        });
        if (!this.repo.getMessage(assistant.id)) return; // la conversación se eliminó durante la respuesta
        const final = this.repo.finishMessage(assistant.id, {
          content: response.text || text,
          status: 'complete',
          usage: provider.getReportedUsage(response),
        });
        this.repo.recordObservation(provider.id, { ok: true });
        safeEmit({ type: 'assistant_end', message: final });
      } catch (err) {
        const e = err instanceof ProviderError ? err : provider.classifyProviderError(err);
        if (e.kind !== 'cancelled') {
          log.warn(`Fallo de ${provider.id}/${input.modelId}: ${e.kind} ${e.message}`);
          this.repo.recordObservation(provider.id, { ok: false, kind: e.kind });
        }
        if (!this.repo.getMessage(assistant.id)) return;
        const final = this.repo.finishMessage(assistant.id, {
          content: text,
          status: e.kind === 'cancelled' ? 'cancelled' : 'error',
          errorKind: e.kind,
          errorMessage: e.message,
        });
        safeEmit({ type: 'assistant_end', message: final });
        safeEmit({ type: 'error', kind: e.kind, message: e.message, action: e.action });
      }
    } catch (err) {
      log.error('Error interno al procesar el mensaje.', err);
      safeEmit({
        type: 'error',
        kind: 'unknown',
        message: 'Error interno al procesar el mensaje.',
        action: 'Revisa el registro del servidor.',
      });
    } finally {
      this.active.delete(conversationId);
    }
  }
}

export function buildContext(messages: Message[]): ChatTurn[] {
  const usable = messages.filter((m) => m.content.trim() && (m.role === 'user' || m.status === 'complete'));
  const selected: ChatTurn[] = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && selected.length < CONTEXT_MAX_MESSAGES; i--) {
    const m = usable[i]!;
    if (chars + m.content.length > CONTEXT_MAX_CHARS && selected.length > 0) break;
    selected.unshift({ role: m.role, content: m.content });
    chars += m.content.length;
  }
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...selected];
}

function makeTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}
