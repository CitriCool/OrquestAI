import type { Conversation } from '../../shared/schemas.js';

export type View =
  | { name: 'home' }
  | { name: 'chat'; id: string }
  | { name: 'providers' }
  | { name: 'settings' };

interface Props {
  view: View;
  conversations: Conversation[];
  onNavigate: (v: View) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
}

/** Secciones previstas que aún no existen: se muestran deshabilitadas, sin aparentar funcionar. */
const UPCOMING = ['Proyectos', 'Agentes', 'Tareas en curso'];

export function Sidebar({ view, conversations, onNavigate, onNewChat, onDeleteChat }: Props) {
  return (
    <nav class="sidebar" aria-label="Navegación principal">
      <div class="brand">OrquestAI</div>
      <button class="btn primary block" onClick={onNewChat}>
        + Nuevo chat
      </button>

      <div class="nav-section">
        <div class="nav-title">Historial</div>
        {conversations.length === 0 && <div class="muted small pad">Sin conversaciones.</div>}
        <ul class="conv-list">
          {conversations.map((c) => {
            const active = view.name === 'chat' && view.id === c.id;
            return (
              <li key={c.id} class={active ? 'active' : ''}>
                <button class="conv-link" onClick={() => onNavigate({ name: 'chat', id: c.id })} title={c.title}>
                  {c.title}
                </button>
                <button class="icon-btn" onClick={() => onDeleteChat(c.id)} aria-label={`Eliminar ${c.title}`} title="Eliminar">
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div class="nav-section">
        <button
          class={`nav-link ${view.name === 'providers' ? 'active' : ''}`}
          onClick={() => onNavigate({ name: 'providers' })}
        >
          Modelos y proveedores
        </button>
        <button class={`nav-link ${view.name === 'settings' ? 'active' : ''}`} onClick={() => onNavigate({ name: 'settings' })}>
          Ajustes
        </button>
        {UPCOMING.map((label) => (
          <button key={label} class="nav-link" disabled title="Aún no disponible en esta versión">
            {label} <span class="tag">Próximamente</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
