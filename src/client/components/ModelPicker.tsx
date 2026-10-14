import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ModelInfo, ProviderStatus } from '../../shared/schemas.js';
import { api, ApiError } from '../api.js';
import { costLabel } from '../format.js';

interface Props {
  providers: ProviderStatus[];
  providerId: string;
  modelId: string;
  disabled?: boolean;
  onChange: (providerId: string, modelId: string) => void;
}

export function ModelPicker({ providers, providerId, modelId, disabled, onChange }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyFree, setOnlyFree] = useState(true);
  const provider = providers.find((p) => p.id === providerId);

  useEffect(() => {
    if (!provider?.configured) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listModels(providerId)
      .then((m) => {
        if (cancelled) return;
        setModels(m);
        if (!m.some((x) => x.id === modelId)) {
          const first = m.find((x) => x.costClass === 'free') ?? m[0];
          if (first) onChange(providerId, first.id);
        }
      })
      .catch((e: ApiError) => !cancelled && setError(`${e.message} ${e.action}`))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [providerId, provider?.configured]);

  const visible = useMemo(
    () => models.filter((m) => !onlyFree || m.costClass === 'free' || m.id === modelId),
    [models, onlyFree, modelId],
  );
  const selected = models.find((m) => m.id === modelId);

  return (
    <div class="model-picker">
      <label>
        <span class="sr-only">Proveedor</span>
        <select
          value={providerId}
          disabled={disabled}
          onChange={(e) => onChange((e.target as HTMLSelectElement).value, '')}
          aria-label="Proveedor"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.configured}>
              {p.label}
              {p.configured ? '' : ' (sin configurar)'}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span class="sr-only">Modelo</span>
        <select
          value={modelId}
          disabled={disabled || loading || !provider?.configured}
          onChange={(e) => onChange(providerId, (e.target as HTMLSelectElement).value)}
          aria-label="Modelo"
        >
          {loading && <option>Cargando modelos…</option>}
          {!loading && visible.length === 0 && <option value="">Sin modelos disponibles</option>}
          {!loading &&
            visible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {costLabel(m.costClass)}
              </option>
            ))}
        </select>
      </label>
      <label class="check">
        <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree((e.target as HTMLInputElement).checked)} />
        Solo gratuitos
      </label>
      {selected && selected.costClass !== 'free' && (
        <span class="badge warn">Este modelo no es gratuito: esta versión no lo permite.</span>
      )}
      {error && <span class="badge danger">{error}</span>}
    </div>
  );
}
