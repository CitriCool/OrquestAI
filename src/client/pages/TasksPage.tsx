import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  Agent,
  ComplexityLevel,
  Plan,
  ProviderStatus,
  ReviewLevel,
  Task,
  TaskDetail,
} from '../../shared/schemas.js';
import { LIMITS } from '../../shared/limits.js';
import { api, ApiError } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { ModelPicker } from '../components/ModelPicker.js';
import {
  complexityLabel,
  errorKindLabel,
  formatTime,
  planStatusLabel,
  reviewLevelLabel,
  runKindLabel,
  taskStatusLabel,
  usageLabel,
} from '../format.js';

const POLL_MS = 1_500;

export function TasksPage({ initialId }: { initialId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  /** Id de la tarea abierta, o 'nueva' para el formulario. */
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = async () => {
    try {
      const list = await api.listTasks();
      setTasks(list);
      setSelected((cur) => cur ?? list[0]?.id ?? 'nueva');
    } catch (e) {
      setError(e as ApiError);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section class="page tasks-page">
      <h1>Tareas</h1>
      <p class="muted">
        Describe un objetivo y el Coordinador propone un plan: complejidad, criterios de aceptación, subtareas y agentes.
        Revisas el plan y lo apruebas. La ejecución de las subtareas llega en el próximo sprint.
      </p>
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}

      <div class="agents-layout">
        <ul class="agent-list" aria-label="Lista de tareas">
          <li>
            <button class={`agent-item new ${selected === 'nueva' ? 'active' : ''}`} onClick={() => setSelected('nueva')}>
              + Nueva tarea
            </button>
          </li>
          {tasks.map((t) => (
            <li key={t.id}>
              <button class={`agent-item ${t.id === selected ? 'active' : ''}`} onClick={() => setSelected(t.id)}>
                <span class="agent-name">{t.title}</span>
                <span class="agent-tags">
                  <span class={`badge task-${t.status}`}>{taskStatusLabel(t.status)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {selected === 'nueva' && (
          <NewTaskForm
            onCreated={async (t) => {
              setSelected(t.id);
              await load();
            }}
          />
        )}
        {selected && selected !== 'nueva' && (
          <TaskView
            key={selected}
            taskId={selected}
            onChanged={load}
            onDeleted={async () => {
              setSelected(null);
              await load();
            }}
          />
        )}
      </div>
    </section>
  );
}

function NewTaskForm({ onCreated }: { onCreated: (t: Task) => void }) {
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [criteria, setCriteria] = useState('');
  const [reviewLevel, setReviewLevel] = useState<ReviewLevel>('standard');
  const [complexity, setComplexity] = useState<ComplexityLevel | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      onCreated(
        await api.createTask({
          objective,
          context,
          acceptanceCriteria: criteria,
          reviewLevel,
          complexityOverride: complexity,
        }),
      );
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article class="card agent-editor">
      <header class="card-header">
        <h2>Nueva tarea</h2>
      </header>
      <div class="form-grid">
        <label class="wide">
          Objetivo
          <textarea
            rows={3}
            value={objective}
            maxLength={LIMITS.taskObjectiveMax}
            placeholder="Qué quieres conseguir. Por ejemplo: diseñar el modelo de datos de un sistema de inscripciones."
            onInput={(e) => setObjective((e.target as HTMLTextAreaElement).value)}
          />
        </label>
        <label class="wide">
          Contexto (opcional)
          <textarea
            rows={4}
            value={context}
            maxLength={LIMITS.taskContextMax}
            placeholder="Tecnologías, restricciones, código o datos relevantes."
            onInput={(e) => setContext((e.target as HTMLTextAreaElement).value)}
          />
        </label>
        <label class="wide">
          Criterios de aceptación (opcional, uno por línea)
          <textarea
            rows={3}
            value={criteria}
            maxLength={LIMITS.taskCriteriaMax}
            onInput={(e) => setCriteria((e.target as HTMLTextAreaElement).value)}
          />
        </label>
        <label>
          Nivel de revisión
          <select value={reviewLevel} onChange={(e) => setReviewLevel((e.target as HTMLSelectElement).value as ReviewLevel)}>
            {(['none', 'standard', 'strict'] as const).map((r) => (
              <option key={r} value={r}>
                {reviewLevelLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Complejidad
          <ComplexitySelect value={complexity} onChange={setComplexity} />
        </label>
      </div>
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
      <div class="row">
        <button class="btn primary" disabled={!objective.trim() || saving} onClick={create}>
          {saving ? 'Creando…' : 'Crear tarea'}
        </button>
      </div>
    </article>
  );
}

function ComplexitySelect({
  value,
  onChange,
  disabled,
}: {
  value: ComplexityLevel | null;
  onChange: (v: ComplexityLevel | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      aria-label="Nivel de complejidad"
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        onChange(v ? (Number(v) as ComplexityLevel) : null);
      }}
    >
      <option value="">Automática (la propone el Coordinador)</option>
      {([1, 2, 3] as const).map((l) => (
        <option key={l} value={l}>
          {complexityLabel(l)}
        </option>
      ))}
    </select>
  );
}

interface TaskViewProps {
  taskId: string;
  onChanged: () => void;
  onDeleted: () => void;
}

function TaskView({ taskId, onChanged, onDeleted }: TaskViewProps) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [planning, setPlanning] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providerId, setProviderId] = useState('simulado');
  const [modelId, setModelId] = useState('simulado-basico');
  const [feedback, setFeedback] = useState('');
  /** Versión del plan que se está viendo (por omisión, la última). */
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    try {
      const r = await api.getTask(taskId);
      setTask(r.task);
      const active = r.planning || r.task.status === 'planning';
      setPlanning(active);
      if (active) timer.current = setTimeout(() => void refresh(), POLL_MS);
      else onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [provs, agentList, settings] = await Promise.all([api.listProviders(), api.listAgents(), api.getSettings()]);
        setProviders(provs);
        setAgents(agentList);
        // Modelo del Coordinador si lo tiene; si no, el predeterminado de la aplicación.
        const coord = agentList.find((a) => a.id === 'coordinador');
        const pid = coord?.providerId ?? settings.defaultProviderId;
        const mid = coord?.modelId ?? settings.defaultModelId;
        if (provs.some((p) => p.id === pid && p.configured)) {
          setProviderId(pid);
          setModelId(mid);
        }
      } catch (e) {
        setError(e as ApiError);
      }
    })();
    void refresh();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [taskId]);

  if (!task) return <article class="card">{error ? <ErrorBanner error={error} /> : <p class="muted">Cargando…</p>}</article>;

  const provider = providers.find((p) => p.id === providerId);
  const needsConsent = provider ? provider.external && !provider.consentGiven : false;
  const current = [...task.plans].reverse().find((p) => p.status === 'proposed' || p.status === 'approved') ?? null;
  const latest = task.plans.at(-1) ?? null;
  const shown = task.plans.find((p) => p.version === viewVersion) ?? latest;
  const closed = task.status === 'cancelled';

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const startPlan = (withFeedback: boolean) =>
    act(async () => {
      await api.planTask(taskId, { providerId, modelId, ...(withFeedback ? { feedback } : {}) });
      onChanged(); // la lista muestra «Planificando…» de inmediato
      setViewVersion(null);
      if (withFeedback) setFeedback('');
    });

  return (
    <article class="card agent-editor task-view">
      <header class="card-header">
        <h2>{task.title}</h2>
        <span class={`badge task-${task.status}`}>{taskStatusLabel(task.status)}</span>
      </header>

      <details class="task-data">
        <summary>Datos de la tarea</summary>
        <dl class="facts">
          <dt>Objetivo</dt>
          <dd class="pre">{task.objective}</dd>
          <dt>Contexto</dt>
          <dd class="pre">{task.context || '—'}</dd>
          <dt>Criterios</dt>
          <dd class="pre">{task.acceptanceCriteria || '—'}</dd>
          <dt>Revisión</dt>
          <dd>{reviewLevelLabel(task.reviewLevel)}</dd>
          <dt>Creada</dt>
          <dd>{formatTime(task.createdAt)}</dd>
        </dl>
      </details>

      {task.errorMessage && (
        <ErrorBanner
          error={{
            message: `${task.errorKind ? `${errorKindLabel(task.errorKind)}: ` : ''}${task.errorMessage}`,
            action: current ? 'El plan vigente sigue disponible.' : '',
          }}
        />
      )}
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}

      {!closed && (
        <section class="plan-controls">
          <h3>{current ? 'Nueva versión del plan' : 'Planificar con el Coordinador'}</h3>
          <ModelPicker
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            disabled={planning}
            onChange={(p, m) => {
              setProviderId(p);
              setModelId(m);
            }}
          />
          {needsConsent && provider && (
            <div class="banner warn">
              <div>
                <strong>Los datos de la tarea se enviarán a {provider.label}, un servicio externo.</strong>
              </div>
              <button
                class="btn primary small"
                onClick={() =>
                  act(async () => {
                    await api.giveConsent(providerId);
                    setProviders(await api.listProviders());
                  })
                }
              >
                Acepto
              </button>
            </div>
          )}
          {current && (
            <label class="wide-label">
              Cambios que quieres en el plan (opcional)
              <textarea
                rows={3}
                value={feedback}
                maxLength={LIMITS.feedbackMax}
                disabled={planning}
                placeholder="Por ejemplo: agrega una subtarea de pruebas, usa PostgreSQL, separa el diseño de la API."
                onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
              />
            </label>
          )}
          <div class="row">
            {planning ? (
              <>
                <span class="state-pill running">El Coordinador está planificando…</span>
                <button class="btn danger" onClick={() => act(() => api.stopTask(taskId))}>
                  Detener
                </button>
              </>
            ) : (
              <button
                class="btn primary"
                disabled={!modelId || needsConsent}
                onClick={() => startPlan(!!(current && feedback.trim()))}
              >
                {current ? (feedback.trim() ? 'Pedir nueva versión con estos cambios' : 'Generar otra versión') : 'Generar plan'}
              </button>
            )}
          </div>
        </section>
      )}

      {task.plans.length > 1 && (
        <div class="row versions">
          <span class="muted small">Versiones:</span>
          {task.plans.map((p) => (
            <button
              key={p.id}
              class={`btn small ${p.version === shown?.version ? 'primary' : 'ghost'}`}
              onClick={() => setViewVersion(p.version)}
            >
              v{p.version} · {planStatusLabel(p.status)}
            </button>
          ))}
        </div>
      )}

      {shown && (
        <PlanView
          plan={shown}
          task={task}
          agents={agents}
          canApprove={!planning && task.status === 'plan_ready' && shown.id === current?.id && shown.status === 'proposed'}
          onApprove={() => act(() => api.approvePlan(taskId, shown.id))}
          onOverride={(level) => act(() => api.updateTask(taskId, { complexityOverride: level }))}
          lockOverride={planning || closed || task.status === 'approved'}
        />
      )}

      {task.runs.length > 0 && (
        <details class="task-data" open={task.runs.some((r) => r.status === 'error')}>
          <summary>Llamadas a modelos ({task.runs.length})</summary>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Agente</th>
                  <th>Modelo</th>
                  <th>Estado</th>
                  <th>Uso</th>
                  <th>Inicio</th>
                </tr>
              </thead>
              <tbody>
                {task.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{runKindLabel(r.kind)}</td>
                    <td>{agents.find((a) => a.id === r.agentId)?.name ?? '—'}</td>
                    <td class="small">
                      {r.providerId} / {r.modelId}
                    </td>
                    <td>
                      <span class={`badge status-${r.status === 'running' ? 'streaming' : r.status}`}>{r.status}</span>
                      {r.errorMessage && <div class="msg-error">{r.errorMessage}</div>}
                    </td>
                    <td class="small">{usageLabel(r.usage) ?? '—'}</td>
                    <td class="small">{formatTime(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div class="row task-actions">
        {!closed && task.status !== 'approved' && (
          <button
            class="btn ghost"
            onClick={() => confirm('¿Cancelar esta tarea? Podrás consultarla, pero no volver a planificarla.') && act(() => api.cancelTask(taskId))}
          >
            Cancelar tarea
          </button>
        )}
        <button
          class="btn danger"
          onClick={async () => {
            if (!confirm('¿Eliminar la tarea con sus planes y su historial? No se puede deshacer.')) return;
            try {
              await api.deleteTask(taskId);
              onDeleted();
            } catch (e) {
              setError(e as ApiError);
            }
          }}
        >
          Eliminar tarea
        </button>
      </div>
    </article>
  );
}

interface PlanViewProps {
  plan: Plan;
  task: TaskDetail;
  agents: Agent[];
  canApprove: boolean;
  lockOverride: boolean;
  onApprove: () => void;
  onOverride: (level: ComplexityLevel | null) => void;
}

function PlanView({ plan, task, agents, canApprove, lockOverride, onApprove, onOverride }: PlanViewProps) {
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const c = plan.content;

  return (
    <section class="plan">
      <div class="card-header">
        <h3>Plan v{plan.version}</h3>
        <span class={`badge plan-${plan.status}`}>{planStatusLabel(plan.status)}</span>
        <span class="muted small">
          {plan.providerId} / {plan.modelId} · {formatTime(plan.createdAt)}
        </span>
      </div>
      {plan.feedback && <p class="muted small">Cambios pedidos: {plan.feedback}</p>}

      {!c && (
        <div class="banner error">
          <div>
            <strong>El Coordinador no produjo un plan válido.</strong>
            <ul class="notes">
              {plan.validationErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {c && (
        <>
          <p>
            <strong>Objetivo interpretado:</strong> {c.interpretedObjective}
          </p>

          <dl class="facts">
            <dt>Complejidad propuesta</dt>
            <dd>
              {complexityLabel(c.complexity.level)}: {c.complexity.justification}
            </dd>
            <dt>Estimación por reglas</dt>
            <dd>{complexityLabel(plan.ruleComplexity)}</dd>
            <dt>Nivel definitivo</dt>
            <dd>
              <ComplexitySelect value={task.complexityOverride} onChange={onOverride} disabled={lockOverride} />{' '}
              <span class="muted small">
                → {complexityLabel(task.complexityOverride ?? c.complexity.level)}
                {task.complexityOverride ? ' (fijado por ti)' : ' (el del Coordinador)'}
              </span>
            </dd>
            {plan.limits && (
              <>
                <dt>Límites de ejecución</dt>
                <dd>
                  Hasta {plan.limits.maxRounds} {plan.limits.maxRounds === 1 ? 'ronda' : 'rondas'} y {plan.limits.maxCalls}{' '}
                  llamadas · solo modelos gratuitos
                </dd>
              </>
            )}
          </dl>

          {c.questions.length > 0 && (
            <div class="banner warn">
              <div>
                <strong>El Coordinador tiene preguntas.</strong> Respóndelas en «Cambios que quieres en el plan».
                <ul class="notes">
                  {c.questions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <h4>Criterios de aceptación</h4>
          <ul>
            {c.acceptanceCriteria.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>

          <h4>Subtareas</h4>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Subtarea</th>
                  <th>Agente</th>
                  <th>Depende de</th>
                  <th>Entrega esperada</th>
                </tr>
              </thead>
              <tbody>
                {c.subtasks.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <code>{s.id}</code>
                    </td>
                    <td>
                      <strong>{s.title}</strong>
                      <div class="small">{s.description}</div>
                    </td>
                    <td>{agentName(s.agentId)}</td>
                    <td>{s.dependsOn.length ? s.dependsOn.join(', ') : '—'}</td>
                    <td class="small">{s.expectedOutput}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>Revisión</h4>
          <p>{c.reviewStrategy}</p>
          <h4>Condiciones de finalización</h4>
          <ul>
            {c.completionConditions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {c.assumptions.length > 0 && (
            <>
              <h4>Supuestos</h4>
              <ul>
                {c.assumptions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}

          {canApprove && (
            <div class="row">
              <button class="btn primary" onClick={onApprove}>
                Aprobar plan
              </button>
              <span class="muted small">Al aprobarlo queda listo para ejecutarse (Sprint 2.3).</span>
            </div>
          )}
          {plan.status === 'approved' && <p class="ok-text">Plan aprobado el {formatTime(plan.approvedAt)}.</p>}
        </>
      )}
    </section>
  );
}
