import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatEvent, ConversationDetail, Message, ProviderStatus } from '../../shared/schemas.js';
import { LIMITS } from '../../shared/limits.js';
import { api, ApiError } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { ModelPicker } from '../components/ModelPicker.js';
import { errorKindLabel, statusLabel, usageLabel } from '../format.js';

interface Props {
  conversationId: string;
  onChanged: () => void;
}

export function ChatPage({ conversationId, onChanged }: Props) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providerId, setProviderId] = useState('simulado');
  const [modelId, setModelId] = useState('simulado-basico');
  const [input, setInput] = useState('');
  const [title, setTitle] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ message: string; action: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [conv, provs, settings] = await Promise.all([
        api.getConversation(conversationId),
        api.listProviders(),
        api.getSettings(),
      ]);
      setDetail(conv.conversation);
      setTitle(conv.conversation.title);
      setRunning(conv.running);
      setProviders(provs);
      if (provs.some((p) => p.id === settings.defaultProviderId && p.configured)) {
        setProviderId(settings.defaultProviderId);
        setModelId(settings.defaultModelId);
      }
    } catch (e) {
      setError(e as ApiError);
    }
  };

  useEffect(() => {
    void load();
  }, [conversationId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [detail?.messages.length, detail?.messages.at(-1)?.content]);

  const provider = providers.find((p) => p.id === providerId);
  const needsConsent = provider ? provider.external && !provider.consentGiven : false;

  const changeModel = (pid: string, mid: string) => {
    setProviderId(pid);
    setModelId(mid);
    if (mid) void api.saveSettings({ defaultProviderId: pid, defaultModelId: mid }).catch(() => undefined);
  };

  const upsert = (m: Message) =>
    setDetail((d) => {
      if (!d) return d;
      const i = d.messages.findIndex((x) => x.id === m.id);
      const messages = i >= 0 ? d.messages.map((x) => (x.id === m.id ? m : x)) : [...d.messages, m];
      return { ...d, messages };
    });

  const onEvent = (e: ChatEvent) => {
    if (e.type === 'user_message' || e.type === 'assistant_start' || e.type === 'assistant_end') upsert(e.message);
    else if (e.type === 'delta') {
      setDetail((d) =>
        d
          ? { ...d, messages: d.messages.map((m) => (m.id === e.messageId ? { ...m, content: m.content + e.text } : m)) }
          : d,
      );
    } else if (e.type === 'error' && e.kind !== 'cancelled') setError({ message: e.message, action: e.action });
  };

  const sendMsg = async () => {
    const content = input.trim();
    if (!content || running || !modelId) return;
    setError(null);
    setRunning(true);
    setInput('');
    try {
      await api.sendMessage(conversationId, { content, providerId, modelId }, onEvent);
    } catch (e) {
      setError(e as ApiError);
      setInput(content); // no se pierde lo escrito si el envío se rechazó
    } finally {
      setRunning(false);
      onChanged();
      const fresh = await api.getConversation(conversationId).catch(() => null);
      if (fresh) {
        setDetail(fresh.conversation);
        setTitle(fresh.conversation.title);
      }
    }
  };

  const stop = async () => {
    try {
      await api.stop(conversationId);
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const saveTitle = async () => {
    const t = title.trim();
    if (!detail || !t || t === detail.title) return setTitle(detail?.title ?? '');
    try {
      await api.renameConversation(conversationId, t);
      setDetail({ ...detail, title: t });
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const acceptConsent = async () => {
    try {
      await api.giveConsent(providerId);
      setProviders(await api.listProviders());
    } catch (e) {
      setError(e as ApiError);
    }
  };

  if (!detail) {
    return <section class="page">{error ? <ErrorBanner error={error} /> : <p class="muted">Cargando…</p>}</section>;
  }

  return (
    <section class="chat">
      <header class="chat-header">
        <input
          class="title-input"
          value={title}
          maxLength={LIMITS.titleMax}
          aria-label="Título de la conversación"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span class={`state-pill ${running ? 'running' : 'idle'}`}>{running ? 'Generando respuesta' : 'En espera'}</span>
      </header>

      <div class="messages" ref={listRef} aria-live="polite">
        {detail.messages.length === 0 && (
          <p class="muted center">Escribe tu primer mensaje. Con el proveedor «Simulado» puedes probar sin claves.</p>
        )}
        {detail.messages.map((m) => (
          <article key={m.id} class={`msg ${m.role}`}>
            <div class="msg-meta">
              <strong>{m.role === 'user' ? 'Tú' : 'Asistente'}</strong>
              {m.role === 'assistant' && (
                <>
                  <span class="muted">
                    {m.providerId} / {m.modelId}
                  </span>
                  <span class={`badge status-${m.status}`}>{statusLabel(m.status)}</span>
                </>
              )}
            </div>
            <div class="msg-body">{m.content || (m.status === 'streaming' ? '…' : '')}</div>
            {m.errorKind && m.errorKind !== 'cancelled' && (
              <div class="msg-error">
                {errorKindLabel(m.errorKind)}: {m.errorMessage}
                {m.content && ' Se conservó la parte recibida.'}
              </div>
            )}
            {m.status === 'cancelled' && m.content && <div class="muted small">Respuesta parcial conservada.</div>}
            {m.usage && <div class="muted small">{usageLabel(m.usage)}</div>}
          </article>
        ))}
      </div>

      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}

      {needsConsent && provider && (
        <div class="banner warn">
          <div>
            <strong>Aviso: tus mensajes se enviarán a {provider.label}, un servicio externo.</strong>
            {provider.notes.map((n) => (
              <div key={n} class="banner-action">
                {n}
              </div>
            ))}
          </div>
          <button class="btn primary small" onClick={acceptConsent}>
            Acepto
          </button>
        </div>
      )}

      <footer class="composer">
        <ModelPicker
          providers={providers}
          providerId={providerId}
          modelId={modelId}
          disabled={running}
          onChange={changeModel}
        />
        <div class="composer-row">
          <textarea
            value={input}
            maxLength={LIMITS.messageMax}
            placeholder="Escribe tu mensaje. Enter envía, Mayús+Enter añade una línea."
            aria-label="Mensaje"
            rows={4}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMsg();
              }
            }}
          />
          {running ? (
            <button class="btn danger" onClick={stop}>
              Detener
            </button>
          ) : (
            <button class="btn primary" onClick={sendMsg} disabled={!input.trim() || !modelId || needsConsent}>
              Enviar
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
