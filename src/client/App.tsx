import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Conversation } from '../shared/schemas.js';
import { api, ApiError } from './api.js';
import { Sidebar, type View } from './components/Sidebar.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { ChatPage } from './pages/ChatPage.js';
import { ProvidersPage } from './pages/ProvidersPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

export function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const newChat = async () => {
    try {
      const c = await api.createConversation();
      await refresh();
      setView({ name: 'chat', id: c.id });
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const deleteChat = async (id: string) => {
    if (!confirm('¿Eliminar esta conversación y todos sus mensajes? No se puede deshacer.')) return;
    try {
      await api.deleteConversation(id);
      if (view.name === 'chat' && view.id === id) setView({ name: 'home' });
      await refresh();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  return (
    <div class="layout">
      <Sidebar
        view={view}
        conversations={conversations}
        onNavigate={setView}
        onNewChat={newChat}
        onDeleteChat={deleteChat}
      />
      <main class="main">
        {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
        {view.name === 'home' && (
          <section class="empty-state">
            <h1>OrquestAI</h1>
            <p>Tu escritorio personal de IA. Empieza una conversación con «Nuevo chat».</p>
            <p class="muted">
              El proveedor «Simulado» funciona sin claves ni conexión. Para usar modelos reales, configura las claves en
              el archivo <code>.env</code> y revisa «Modelos y proveedores».
            </p>
            <button class="btn primary" onClick={newChat}>
              Nuevo chat
            </button>
          </section>
        )}
        {view.name === 'chat' && <ChatPage key={view.id} conversationId={view.id} onChanged={refresh} />}
        {view.name === 'providers' && <ProvidersPage />}
        {view.name === 'settings' && (
          <SettingsPage
            onDataDeleted={() => {
              setView({ name: 'home' });
              void refresh();
            }}
          />
        )}
      </main>
    </div>
  );
}
