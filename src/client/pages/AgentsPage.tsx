import { useEffect, useState } from 'preact/hooks';
import type { Agent, AgentRole, ProviderStatus, UpdateAgentInput } from '../../shared/schemas.js';
import { LIMITS } from '../../shared/limits.js';
import { api, ApiError } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { ModelPicker } from '../components/ModelPicker.js';
import { formatTime } from '../format.js';

const ROLE_LABELS: Record<AgentRole, string> = {
  coordinator: 'Coordinador',
  developer: 'Desarrollador',
  architect: 'Arquitecto',
  reviewer: 'Revisor',
  specialist: 'Especialista',
  tutor: 'Tutor',
  synthesizer: 'Sintetizador',
  custom: 'Personalizado',
};

/** Formulario: los campos opcionales vacíos se envían como null. */
interface Draft {
  name: string;
  description: string;
  instructions: string;
  specialty: string;
  providerId: string | null;
  modelId: string | null;
  fallbackProviderId: string | null;
  fallbackModelId: string | null;
  maxOutputTokens: string;
  temperature: string;
  enabled: boolean;
}

const EMPTY: Draft = {
  name: '',
  description: '',
  instructions: '',
  specialty: '',
  providerId: null,
  modelId: null,
  fallbackProviderId: null,
  fallbackModelId: null,
  maxOutputTokens: '',
  temperature: '',
  enabled: true,
};

function toDraft(a: Agent): Draft {
  return {
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    specialty: a.specialty ?? '',
    providerId: a.providerId,
    modelId: a.modelId,
    fallbackProviderId: a.fallbackProviderId,
    fallbackModelId: a.fallbackModelId,
    maxOutputTokens: a.maxOutputTokens?.toString() ?? '',
    temperature: a.temperature?.toString() ?? '',
    enabled: a.enabled,
  };
}

function fromDraft(d: Draft): UpdateAgentInput & { name: string; instructions: string } {
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return {
    name: d.name,
    description: d.description,
    instructions: d.instructions,
    specialty: d.specialty.trim() || null,
    providerId: d.modelId ? d.providerId : null,
    modelId: d.providerId ? d.modelId : null,
    fallbackProviderId: d.fallbackModelId ? d.fallbackProviderId : null,
    fallbackModelId: d.fallbackProviderId ? d.fallbackModelId : null,
    maxOutputTokens: num(d.maxOutputTokens),
    temperature: num(d.temperature),
    enabled: d.enabled,
  };
}

export function AgentsPage({ onChat }: { onChat: (agentId: string) => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  /** Id del agente seleccionado, o 'nuevo' para crear uno. */
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = async (select?: string | null) => {
    try {
      const [list, provs] = await Promise.all([api.listAgents(), api.listProviders()]);
      setAgents(list);
      setProviders(provs);
      setSelected((cur) => (select !== undefined ? select : (cur ?? list[0]?.id ?? null)));
    } catch (e) {
      setError(e as ApiError);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const agent = agents.find((a) => a.id === selected) ?? null;

  return (
    <section class="page agents-page">
      <h1>Agentes</h1>
      <p class="muted">
        Cada agente tiene un rol, instrucciones propias y, si quieres, un modelo preferido. En esta versión puedes
        conversar con un agente concreto; la orquestación entre agentes llega en los próximos sprints.
      </p>
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}

      <div class="agents-layout">
        <ul class="agent-list" aria-label="Lista de agentes">
          {agents.map((a) => (
            <li key={a.id}>
              <button class={`agent-item ${a.id === selected ? 'active' : ''}`} onClick={() => setSelected(a.id)}>
                <span class="agent-name">{a.name}</span>
                <span class="agent-tags">
                  <span class="tag">{ROLE_LABELS[a.role]}</span>
                  {!a.enabled && <span class="badge warn">Deshabilitado</span>}
                </span>
              </button>
            </li>
          ))}
          <li>
            <button class={`agent-item new ${selected === 'nuevo' ? 'active' : ''}`} onClick={() => setSelected('nuevo')}>
              + Nuevo agente
            </button>
          </li>
        </ul>

        {selected === 'nuevo' && (
          <AgentEditor
            key="nuevo"
            agent={null}
            providers={providers}
            onSaved={(a) => load(a.id)}
            onDeleted={() => load(null)}
            onChat={onChat}
          />
        )}
        {agent && (
          <AgentEditor
            key={`${agent.id}-${agent.updatedAt}`}
            agent={agent}
            providers={providers}
            onSaved={(a) => load(a.id)}
            onDeleted={() => load(null)}
            onChat={onChat}
          />
        )}
      </div>
    </section>
  );
}

interface EditorProps {
  agent: Agent | null;
  providers: ProviderStatus[];
  onSaved: (a: Agent) => void;
  onDeleted: () => void;
  onChat: (agentId: string) => void;
}

function AgentEditor({ agent, providers, onSaved, onDeleted, onChat }: EditorProps) {
  const [draft, setDraft] = useState<Draft>(agent ? toDraft(agent) : EMPTY);
  const [role, setRole] = useState<'specialist' | 'custom'>('custom');
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const firstProvider = providers.find((p) => p.configured)?.id ?? 'simulado';

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = fromDraft(draft);
      const result = agent ? await api.updateAgent(agent.id, input) : await api.createAgent({ ...input, role });
      setSaved(true);
      onSaved(result);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!agent || !confirm(`¿Eliminar el agente «${agent.name}»? Sus conversaciones se conservan sin agente.`)) return;
    try {
      await api.deleteAgent(agent.id);
      onDeleted();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const reset = async () => {
    if (!agent || !confirm(`¿Restaurar «${agent.name}» a sus valores iniciales? Se pierden tus cambios en este agente.`)) return;
    try {
      onSaved(await api.resetAgent(agent.id));
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const showSpecialty = agent ? agent.role === 'specialist' || agent.role === 'custom' : true;
  const valid = draft.name.trim() && draft.instructions.trim();

  return (
    <article class="card agent-editor">
      <header class="card-header">
        <h2>{agent ? agent.name : 'Nuevo agente'}</h2>
        {agent && <span class="tag">{ROLE_LABELS[agent.role]}</span>}
        {agent?.builtin && <span class="badge ok">Agente inicial</span>}
      </header>

      {agent && (
        <dl class="facts">
          <dt>Identificador</dt>
          <dd>
            <code>{agent.id}</code>
          </dd>
          <dt>Ejecuciones</dt>
          <dd>
            {agent.runs} {agent.runs === 1 ? 'respuesta' : 'respuestas'}
            {agent.lastRunAt && ` · última: ${formatTime(agent.lastRunAt)}`}
          </dd>
        </dl>
      )}

      <div class="form-grid">
        {!agent && (
          <label>
            Tipo
            <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as 'specialist' | 'custom')}>
              <option value="custom">Personalizado</option>
              <option value="specialist">Especialista</option>
            </select>
          </label>
        )}
        <label>
          Nombre
          <input
            value={draft.name}
            maxLength={LIMITS.agentNameMax}
            onInput={(e) => set('name', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="wide">
          Descripción
          <input
            value={draft.description}
            maxLength={LIMITS.agentDescriptionMax}
            onInput={(e) => set('description', (e.target as HTMLInputElement).value)}
          />
        </label>
        {showSpecialty && (
          <label class="wide">
            Especialidad
            <input
              value={draft.specialty}
              maxLength={LIMITS.agentSpecialtyMax}
              placeholder="Por ejemplo: redes, seguridad defensiva, análisis de datos"
              onInput={(e) => set('specialty', (e.target as HTMLInputElement).value)}
            />
          </label>
        )}
        <label class="wide">
          Instrucciones
          <textarea
            rows={9}
            value={draft.instructions}
            maxLength={LIMITS.agentInstructionsMax}
            onInput={(e) => set('instructions', (e.target as HTMLTextAreaElement).value)}
          />
          <span class="muted small">
            Se envían como instrucciones de sistema, separadas de tus mensajes. {draft.instructions.length}/
            {LIMITS.agentInstructionsMax}
          </span>
        </label>
      </div>

      <h3>Modelo preferido</h3>
      <ModelChoice
        providers={providers}
        providerId={draft.providerId}
        modelId={draft.modelId}
        fallbackProvider={firstProvider}
        emptyLabel="Usar el modelo elegido en el chat"
        onChange={(p, m) => {
          set('providerId', p);
          set('modelId', m);
        }}
      />

      <h3>Modelo de respaldo</h3>
      <p class="muted small">Se guarda ahora; la transferencia automática al respaldo llega en la Fase 4.</p>
      <ModelChoice
        providers={providers}
        providerId={draft.fallbackProviderId}
        modelId={draft.fallbackModelId}
        fallbackProvider={firstProvider}
        emptyLabel="Sin respaldo"
        onChange={(p, m) => {
          set('fallbackProviderId', p);
          set('fallbackModelId', m);
        }}
      />

      <h3>Parámetros</h3>
      <div class="form-grid">
        <label>
          Máximo de tokens de salida
          <input
            type="number"
            min={1}
            max={LIMITS.agentMaxOutputTokens}
            placeholder="Sin límite propio"
            value={draft.maxOutputTokens}
            onInput={(e) => set('maxOutputTokens', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Temperatura (0 a 2)
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            placeholder="La del modelo"
            value={draft.temperature}
            onInput={(e) => set('temperature', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="check">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', (e.target as HTMLInputElement).checked)} />
          Habilitado
        </label>
      </div>

      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}

      <div class="row">
        <button class="btn primary" onClick={save} disabled={!valid || saving}>
          {saving ? 'Guardando…' : agent ? 'Guardar cambios' : 'Crear agente'}
        </button>
        {agent && (
          <button class="btn" onClick={() => onChat(agent.id)} disabled={!agent.enabled}>
            Conversar con este agente
          </button>
        )}
        {agent?.builtin && (
          <button class="btn ghost" onClick={reset}>
            Restaurar valores iniciales
          </button>
        )}
        {agent && !agent.builtin && (
          <button class="btn danger" onClick={remove}>
            Eliminar
          </button>
        )}
        {saved && <span class="ok-text">Guardado.</span>}
      </div>
    </article>
  );
}

interface ModelChoiceProps {
  providers: ProviderStatus[];
  providerId: string | null;
  modelId: string | null;
  fallbackProvider: string;
  emptyLabel: string;
  onChange: (providerId: string | null, modelId: string | null) => void;
}

/** Casilla «sin modelo propio» o selector de proveedor y modelo. */
function ModelChoice({ providers, providerId, modelId, fallbackProvider, emptyLabel, onChange }: ModelChoiceProps) {
  const custom = providerId !== null;
  return (
    <div class="model-choice">
      <label class="check">
        <input
          type="checkbox"
          checked={!custom}
          onChange={(e) => ((e.target as HTMLInputElement).checked ? onChange(null, null) : onChange(fallbackProvider, ''))}
        />
        {emptyLabel}
      </label>
      {custom && (
        <ModelPicker
          providers={providers}
          providerId={providerId}
          modelId={modelId ?? ''}
          onChange={(p, m) => onChange(p, m || null)}
        />
      )}
    </div>
  );
}
