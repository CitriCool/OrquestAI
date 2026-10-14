import { useEffect, useRef, useState } from 'preact/hooks';
import { formatUsd } from '../../shared/pricing.js';
import type {
  Agent,
  ComplexityLevel,
  CostMode,
  Plan,
  PlanContent,
  ProviderStatus,
  ReviewContent,
  ReviewLevel,
  Task,
  TaskDetail,
  TaskRun,
} from '../../shared/schemas.js';
import { LIMITS } from '../../shared/limits.js';
import { api, ApiError } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { ModelPicker } from '../components/ModelPicker.js';
import {
  complexityLabel,
  costModeLabel,
  errorKindLabel,
  formatTime,
  planStatusLabel,
  reviewLevelLabel,
  runKindLabel,
  runStatusLabel,
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
        Lo revisas, lo apruebas y lo ejecutas: cada agente hace su parte, el Revisor crítico la evalúa y el Sintetizador
        integra el resultado.
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
  const [costMode, setCostMode] = useState<CostMode | null>(null);
  const [budget, setBudget] = useState('');
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
          costMode,
          budgetUsd: budget.trim() === '' ? null : Number(budget),
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
        <label>
          Modo de coste
          <CostModeSelect value={costMode} onChange={setCostMode} />
        </label>
        <label>
          Presupuesto de la tarea (USD)
          <input
            type="number"
            min={0}
            step={0.01}
            placeholder="El de Ajustes"
            value={budget}
            onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
          />
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

function CostModeSelect({
  value,
  onChange,
  disabled,
}: {
  value: CostMode | null;
  onChange: (v: CostMode | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      aria-label="Modo de coste de la tarea"
      onChange={(e) => onChange(((e.target as HTMLSelectElement).value || null) as CostMode | null)}
    >
      <option value="">El de Ajustes</option>
      {(['free', 'economic', 'manual'] as const).map((m) => (
        <option key={m} value={m}>
          {costModeLabel(m)}
        </option>
      ))}
    </select>
  );
}

/** Modo y presupuesto de la tarea, con lo gastado. */
function TaskCosts({ task, locked, onChange }: { task: TaskDetail; locked: boolean; onChange: (v: { costMode?: CostMode | null; budgetUsd?: number | null }) => void }) {
  const [budget, setBudget] = useState(task.budgetUsd?.toString() ?? '');
  const s = task.spending;
  return (
    <section class="task-costs">
      <div class="row">
        <label class="inline">
          Modo de coste
          <CostModeSelect value={task.costMode} disabled={locked} onChange={(v) => onChange({ costMode: v })} />
        </label>
        <span class="muted small">→ se aplica {costModeLabel(task.effectiveCostMode)}</span>
      </div>
      <div class="row">
        <label class="inline">
          Presupuesto (USD)
          <input
            type="number"
            min={0}
            step={0.01}
            placeholder="El de Ajustes"
            value={budget}
            disabled={locked}
            onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
            onBlur={() => {
              const v = budget.trim() === '' ? null : Number(budget);
              if (v !== task.budgetUsd) onChange({ budgetUsd: v });
            }}
          />
        </label>
        <span class="small">
          Gastado {formatUsd(s.spentUsd)} de {formatUsd(s.budgetUsd)}
          {s.estimatedUsd > 0 && ` (${formatUsd(s.estimatedUsd)} estimado)`}
        </span>
        {s.unknownCalls > 0 && <span class="badge warn">{s.unknownCalls} llamada(s) de coste desconocido</span>}
      </div>
    </section>
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
  const [executing, setExecuting] = useState(false);
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
      const isPlanning = r.planning || r.task.status === 'planning';
      const isExecuting = r.executing || r.task.status === 'running';
      setPlanning(isPlanning);
      setExecuting(isExecuting);
      if (isPlanning || isExecuting) timer.current = setTimeout(() => void refresh(), POLL_MS);
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
  const busy = planning || executing;
  const hasExecutions = task.runs.some((r) => r.execution !== null);

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

  const startExecution = () =>
    act(async () => {
      await api.executeTask(taskId, { providerId, modelId });
      onChanged();
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

      <TaskCosts
        key={`${task.costMode}-${task.budgetUsd}`}
        task={task}
        locked={busy || closed}
        onChange={(v) => act(() => api.updateTask(taskId, v))}
      />

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
          <h3>Modelo</h3>
          <p class="muted small">
            Se usa para planificar y para los agentes que no tienen un modelo preferido.
          </p>
          <ModelPicker
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            disabled={busy}
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
          {current && !executing && (
            <label class="wide-label">
              Cambios que quieres en el plan (opcional)
              <textarea
                rows={3}
                value={feedback}
                maxLength={LIMITS.feedbackMax}
                disabled={busy}
                placeholder="Por ejemplo: agrega una subtarea de pruebas, usa PostgreSQL, separa el diseño de la API."
                onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
              />
            </label>
          )}
          <div class="row">
            {busy ? (
              <>
                <span class="state-pill running">
                  {planning ? 'El Coordinador está planificando…' : 'Los agentes están trabajando…'}
                </span>
                <button class="btn danger" onClick={() => act(() => api.stopTask(taskId))}>
                  Detener
                </button>
              </>
            ) : (
              <>
                {current?.status === 'approved' && task.status !== 'done' && (
                  <button class="btn primary" disabled={!modelId || needsConsent} onClick={startExecution}>
                    {hasExecutions ? 'Ejecutar de nuevo' : 'Ejecutar plan'}
                  </button>
                )}
                <button
                  class={`btn ${current?.status === 'approved' ? '' : 'primary'}`}
                  disabled={!modelId || needsConsent}
                  onClick={() => startPlan(!!(current && feedback.trim()))}
                >
                  {current ? (feedback.trim() ? 'Pedir nueva versión con estos cambios' : 'Generar otra versión del plan') : 'Generar plan'}
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {hasExecutions && (
        <ExecutionView
          task={task}
          agents={agents}
          executing={executing}
          onAccept={() => act(() => api.acceptTask(taskId))}
        />
      )}

      <details class="plan-wrap" open={!hasExecutions}>
      <summary>Plan{current ? ` v${current.version} · ${planStatusLabel(current.status)}` : ''}</summary>
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
          canApprove={!busy && task.status === 'plan_ready' && shown.id === current?.id && shown.status === 'proposed'}
          onApprove={() => act(() => api.approvePlan(taskId, shown.id))}
          onOverride={(level) => act(() => api.updateTask(taskId, { complexityOverride: level }))}
          lockOverride={busy || closed || task.status !== 'plan_ready'}
        />
      )}
      </details>

      {task.runs.length > 0 && (
        <details class="task-data" open={task.runs.some((r) => r.status === 'error')}>
          <summary>Llamadas a modelos ({task.runs.length})</summary>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Ejecución</th>
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
                    <td>{r.execution ?? '—'}</td>
                    <td>{agents.find((a) => a.id === r.agentId)?.name ?? '—'}</td>
                    <td class="small">
                      {r.providerId} / {r.modelId}
                    </td>
                    <td>
                      <span class={`badge status-${r.status === 'running' ? 'streaming' : r.status}`}>{runStatusLabel(r.status)}</span>
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
        {!closed && !busy && task.status !== 'done' && (
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

/** Orden de ejecución de las subtareas según sus dependencias. */
function orderOf(content: PlanContent): string[] {
  const order: string[] = [];
  const pending = [...content.subtasks];
  while (pending.length) {
    const i = pending.findIndex((s) => s.dependsOn.every((d) => order.includes(d)));
    if (i < 0) break;
    order.push(pending.splice(i, 1)[0]!.id);
  }
  return order;
}

interface ExecutionViewProps {
  task: TaskDetail;
  agents: Agent[];
  executing: boolean;
  onAccept: () => void;
}

/** Flujo de la última ejecución (subtareas, revisión, correcciones y síntesis) y su resultado. */
function ExecutionView({ task, agents, executing, onAccept }: ExecutionViewProps) {
  const latest = Math.max(...task.runs.map((r) => r.execution ?? 0));
  const runs = task.runs.filter((r) => r.execution === latest);
  const plan = task.plans.find((p) => p.id === runs[0]?.planId) ?? null;
  const content = plan?.content ?? null;
  const done = new Set(runs.filter((r) => r.kind === 'subtask').map((r) => r.subtaskId));
  const pendingSubtasks = content ? orderOf(content).filter((id) => !done.has(id)) : [];
  const title = (id: string | null) => content?.subtasks.find((s) => s.id === id)?.title ?? id ?? '';
  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name ?? '—';
  const finished = !executing && task.status !== 'running';

  const download = () => {
    const blob = new Blob([`# ${task.title}\n\n${task.result ?? ''}\n`], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${task.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60) || 'tarea'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section class="execution">
      <div class="card-header">
        <h3>Ejecución {latest}</h3>
        {plan && <span class="muted small">con el plan v{plan.version}</span>}
        {plan?.limits && (
          <span class="muted small">
            · {runs.length} de {plan.limits.maxCalls} llamadas
          </span>
        )}
      </div>

      <ol class="flow">
        {runs.map((r) => (
          <FlowStep key={r.id} run={r} title={title(r.subtaskId)} agentName={agentName(r.agentId)} />
        ))}
        {!finished &&
          pendingSubtasks.map((id) => (
            <li key={id} class="flow-step pending">
              <div class="flow-head">
                <span class="badge">Pendiente</span>
                <strong>Subtarea {id}</strong> · {title(id)}
              </div>
            </li>
          ))}
        {!finished && (
          <li class="flow-step pending">
            <div class="flow-head muted small">Después: revisión crítica y síntesis según el plan.</div>
          </li>
        )}
      </ol>

      {finished && task.result && (
        <div class="result">
          <div class="card-header">
            <h3>Resultado</h3>
            <span class={`badge ${task.outcome === 'complete' ? 'ok' : 'warn'}`}>
              {task.outcome === 'complete' ? 'Completo' : 'Parcial, con limitaciones'}
            </span>
            {task.status === 'done' && <span class="badge ok">Aceptado</span>}
          </div>
          {task.limitations.length > 0 && (
            <ul class="notes">
              {task.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          <div class="result-body pre">{task.result}</div>
          <p class="muted small">
            Las afirmaciones técnicas de los agentes no se verificaron ejecutando código: revísalas antes de usarlas.
          </p>
          <div class="row">
            {task.status === 'completed' && (
              <button class="btn primary" onClick={onAccept}>
                Aceptar resultado
              </button>
            )}
            <button class="btn" onClick={download}>
              Descargar .md
            </button>
            <button class="btn ghost" onClick={() => void navigator.clipboard?.writeText(task.result ?? '')}>
              Copiar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function FlowStep({ run: r, title, agentName }: { run: TaskRun; title: string; agentName: string }) {
  const label =
    r.kind === 'subtask' || r.kind === 'correction'
      ? `${runKindLabel(r.kind)} ${r.subtaskId} · ${title}`
      : `${runKindLabel(r.kind)}${r.round ? ` (ronda ${r.round})` : ''}`;
  return (
    <li class={`flow-step kind-${r.kind} run-${r.status}`}>
      <div class="flow-head">
        <span class={`badge status-${r.status === 'running' ? 'streaming' : r.status}`}>{runStatusLabel(r.status)}</span>
        <strong>{label}</strong>
        <span class="muted small">
          {agentName} · {r.modelId}
          {r.usage && ` · ${r.usage.promptTokens ?? '?'} → ${r.usage.completionTokens ?? '?'} tokens`}
        </span>
      </div>
      {r.errorMessage && <div class="msg-error">{r.errorMessage}</div>}
      {r.review && <ReviewSummary review={r.review} />}
      {r.output && !r.review && (
        <details>
          <summary class="small">Ver entrega</summary>
          <div class="flow-output pre">{r.output}</div>
        </details>
      )}
    </li>
  );
}

function ReviewSummary({ review }: { review: ReviewContent }) {
  return (
    <div class="review">
      <p>
        <span class={`badge ${review.verdict === 'aprobado' ? 'ok' : 'warn'}`}>
          {review.verdict === 'aprobado' ? 'Aprobado' : 'Requiere cambios'}
        </span>{' '}
        {review.summary}
      </p>
      {review.criteria.length > 0 && (
        <ul class="criteria">
          {review.criteria.map((c) => (
            <li key={c.criterion}>
              <span class={`badge ${c.status === 'cumple' ? 'ok' : c.status === 'no_cumple' ? 'danger' : 'warn'}`}>
                {{ cumple: 'Cumple', no_cumple: 'No cumple', no_verificable: 'No verificable' }[c.status]}
              </span>{' '}
              {c.criterion}
              {c.note && <span class="muted small"> · {c.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {review.observations.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Observación</th>
                <th>Gravedad</th>
                <th>Estado</th>
                <th>Corrección sugerida</th>
              </tr>
            </thead>
            <tbody>
              {review.observations.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{o.problem}</strong>
                    {o.evidence && <div class="small muted">{o.evidence}</div>}
                    {o.subtaskId && <div class="small">Subtarea {o.subtaskId}</div>}
                  </td>
                  <td>
                    <span class={`badge ${o.severity === 'alta' ? 'danger' : o.severity === 'media' ? 'warn' : ''}`}>{o.severity}</span>
                  </td>
                  <td>
                    {o.status.replace('_', ' ')}
                    {o.justification && <div class="small muted">{o.justification}</div>}
                  </td>
                  <td class="small">{o.suggestedFix || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
              <span class="muted small">Al aprobarlo podrás ejecutarlo.</span>
            </div>
          )}
          {plan.status === 'approved' && <p class="ok-text">Plan aprobado el {formatTime(plan.approvedAt)}.</p>}
        </>
      )}
    </section>
  );
}
