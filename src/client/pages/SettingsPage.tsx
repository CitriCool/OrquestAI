import { useEffect, useState } from 'preact/hooks';
import { COST_THRESHOLDS, formatUsd } from '../../shared/pricing.js';
import type { CostMode, CostSettings, Spending } from '../../shared/schemas.js';
import { api, ApiError, type CostsInfo } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { costModeLabel } from '../format.js';

const MODE_HELP: Record<CostMode, string> = {
  free: 'Solo modelos con precio 0 en el listado del proveedor. Nunca se cambia solo a un modelo de pago.',
  economic: `Modelos gratuitos y económicos (hasta USD ${COST_THRESHOLDS.lowMaxCompletionPerM} por millón de tokens de salida), dentro de tus presupuestos. Los modelos más caros solo entrarán mediante escalamiento autorizado.`,
  manual: 'Tú eliges cualquier modelo con precio conocido. Cada llamada se estima y se bloquea si supera un presupuesto.',
};

function SpendingRow({ label, s }: { label: string; s: Spending }) {
  const pct = s.budgetUsd > 0 ? Math.min(100, (s.spentUsd / s.budgetUsd) * 100) : s.spentUsd > 0 ? 100 : 0;
  return (
    <div class="spending">
      <div class="row">
        <strong>{label}</strong>
        <span>
          {formatUsd(s.spentUsd)} de {formatUsd(s.budgetUsd)}
        </span>
        {s.estimatedUsd > 0 && <span class="muted small">({formatUsd(s.estimatedUsd)} estimado)</span>}
        {s.unknownCalls > 0 && <span class="badge warn">{s.unknownCalls} llamada(s) de coste desconocido</span>}
      </div>
      <div class="meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Gasto ${label}`}>
        <span style={{ width: `${pct}%` }} class={pct >= 90 ? 'high' : ''} />
      </div>
    </div>
  );
}

function CostSettingsCard() {
  const [info, setInfo] = useState<CostsInfo | null>(null);
  const [draft, setDraft] = useState<CostSettings | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getCosts()
      .then((r) => {
        setInfo(r);
        setDraft(r.settings);
      })
      .catch((e: ApiError) => setError(e));
  }, []);

  if (!draft || !info) return <article class="card">{error ? <ErrorBanner error={error} /> : <p class="muted">Cargando…</p>}</article>;

  const set = <K extends keyof CostSettings>(k: K, v: CostSettings[K]) => {
    setSaved(false);
    setDraft({ ...draft, [k]: v });
  };
  const money = (k: 'taskBudgetUsd' | 'dailyBudgetUsd' | 'monthlyBudgetUsd', label: string) => (
    <label>
      {label} (USD)
      <input
        type="number"
        min={0}
        step={0.01}
        value={draft[k]}
        onInput={(e) => set(k, Number((e.target as HTMLInputElement).value))}
      />
    </label>
  );

  const save = async () => {
    setError(null);
    try {
      const r = await api.saveCosts(draft);
      setInfo(r);
      setDraft(r.settings);
      setSaved(true);
    } catch (e) {
      setError(e as ApiError);
    }
  };

  return (
    <article class="card">
      <h2>Política de costes</h2>
      <p class="muted small">
        Se aplica en el servidor antes de cada llamada: comprueba el modo, estima el coste máximo y lo compara con lo que
        queda de cada presupuesto. Las tareas pueden fijar su propio modo y presupuesto.
      </p>
      <fieldset class="modes">
        <legend>Modo</legend>
        {(['free', 'economic', 'manual'] as const).map((m) => (
          <label key={m} class={`mode ${draft.mode === m ? 'active' : ''}`}>
            <input type="radio" name="cost-mode" checked={draft.mode === m} onChange={() => set('mode', m)} />
            <span>
              <strong>{costModeLabel(m)}</strong>
              <span class="muted small">{MODE_HELP[m]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div class="form-grid">
        {money('taskBudgetUsd', 'Presupuesto por tarea')}
        {money('dailyBudgetUsd', 'Presupuesto diario')}
        {money('monthlyBudgetUsd', 'Presupuesto mensual')}
      </div>
      {draft.mode === 'manual' && (
        <label class="check">
          <input
            type="checkbox"
            checked={draft.allowUnknownCostInManual}
            onChange={(e) => set('allowUnknownCostInManual', (e.target as HTMLInputElement).checked)}
          />
          Permitir modelos sin precio verificable (su gasto no se puede estimar ni limitar)
        </label>
      )}
      <div class="row">
        <button class="btn primary" onClick={save}>
          Guardar política
        </button>
        {saved && <span class="ok-text">Guardada.</span>}
      </div>
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}

      <h3>Gasto</h3>
      <SpendingRow label="Hoy" s={info.spending.today} />
      <SpendingRow label="Este mes" s={info.spending.month} />
      <p class="muted small">
        Suma de costes reportados por los proveedores y, cuando no los informan, de estimaciones (marcadas como tales).
        Los periodos usan la hora de este equipo.
      </p>
    </article>
  );
}

export function SettingsPage({ onDataDeleted }: { onDataDeleted: () => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);

  const deleteAll = async () => {
    try {
      await api.deleteAllData();
      setDone(true);
      setConfirmText('');
      onDataDeleted();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  return (
    <section class="page">
      <h1>Ajustes</h1>

      <CostSettingsCard />

      <article class="card">
        <h2>Claves API</h2>
        <p>
          Las claves se definen en el archivo <code>.env</code> junto a la aplicación (usa <code>.env.example</code> como
          plantilla) y se leen al iniciar el servidor. No se guardan en la base de datos ni se envían a esta interfaz.
        </p>
      </article>

      <article class="card danger-zone">
        <h2>Eliminar todos los datos locales</h2>
        <p>
          Borra conversaciones, mensajes, ajustes y avisos aceptados de la base de datos local. No afecta al archivo{' '}
          <code>.env</code>. No se puede deshacer.
        </p>
        <div class="row">
          <input
            value={confirmText}
            placeholder="Escribe BORRAR para confirmar"
            aria-label="Confirmación de borrado"
            onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)}
          />
          <button class="btn danger" disabled={confirmText !== 'BORRAR'} onClick={deleteAll}>
            Eliminar todo
          </button>
        </div>
        {done && <p class="ok-text">Se eliminaron todos los datos locales.</p>}
        {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
      </article>
    </section>
  );
}
