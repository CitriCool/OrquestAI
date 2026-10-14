import { useEffect, useState } from 'preact/hooks';
import type { ModelInfo, ProviderStatus } from '../../shared/schemas.js';
import { api, ApiError } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { costLabel, errorKindLabel, formatTime } from '../format.js';

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const load = () =>
    api
      .listProviders()
      .then(setProviders)
      .catch((e: ApiError) => setError(e));

  useEffect(() => {
    void load();
  }, []);

  return (
    <section class="page">
      <h1>Modelos y proveedores</h1>
      <p class="muted">
        La disponibilidad mostrada es lo observado en usos anteriores, no una garantía. Las claves API se configuran en
        el archivo <code>.env</code> del servidor y nunca se muestran aquí.
      </p>
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} onChanged={load} />
      ))}
    </section>
  );
}

function ProviderCard({ provider: p, onChanged }: { provider: ProviderStatus; onChanged: () => void }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState('');

  const loadModels = async () => {
    setLoading(true);
    setError(null);
    try {
      setModels(await api.listModels(p.id));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  };

  const consent = async () => {
    try {
      await api.giveConsent(p.id);
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const shown = (models ?? []).filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <article class="card">
      <header class="card-header">
        <h2>{p.label}</h2>
        <span class={`badge ${p.configured ? 'ok' : 'warn'}`}>{p.configured ? 'Configurado' : 'Sin configurar'}</span>
        {p.external && (
          <span class={`badge ${p.consentGiven ? 'ok' : 'warn'}`}>
            {p.consentGiven ? 'Aviso de envío aceptado' : 'Aviso de envío pendiente'}
          </span>
        )}
      </header>
      <ul class="notes">
        {p.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <dl class="facts">
        <dt>Último uso correcto</dt>
        <dd>{formatTime(p.lastSuccessAt)}</dd>
        <dt>Último error</dt>
        <dd>
          {formatTime(p.lastErrorAt)}
          {p.lastErrorKind && ` (${errorKindLabel(p.lastErrorKind)})`}
        </dd>
      </dl>
      <div class="row">
        {p.external && !p.consentGiven && (
          <button class="btn" onClick={consent}>
            Aceptar envío de datos a {p.label}
          </button>
        )}
        <button class="btn" onClick={loadModels} disabled={!p.configured || loading}>
          {loading ? 'Consultando…' : models ? 'Actualizar modelos' : 'Ver modelos'}
        </button>
      </div>
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
      {models && (
        <>
          <input
            class="filter"
            placeholder="Filtrar modelos"
            value={filter}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            aria-label={`Filtrar modelos de ${p.label}`}
          />
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th>Coste</th>
                  <th>Contexto</th>
                  <th>Fuente del dato de coste</th>
                  <th>Verificado</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div>{m.name}</div>
                      <code class="small">{m.id}</code>
                    </td>
                    <td>
                      <span class={`badge ${m.costClass === 'free' ? 'ok' : 'warn'}`}>{costLabel(m.costClass)}</span>
                      {m.restriction && (
                        <span class="badge danger" title={m.restriction}>
                          No disponible aquí
                        </span>
                      )}
                    </td>
                    <td>{m.contextLength ? m.contextLength.toLocaleString('es') : '—'}</td>
                    <td class="small">
                      {m.costSource}
                      {m.restriction && <div class="msg-error">{m.restriction}</div>}
                    </td>
                    <td class="small">{m.verifiedAt ? formatTime(m.verifiedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}
