import { useState } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';

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

      <article class="card">
        <h2>Política de costes</h2>
        <p>
          Modo activo: <strong>A · exclusivamente gratuito</strong>. El servidor bloquea cualquier modelo que no esté
          clasificado como gratuito o cuyo coste no se pueda verificar.
        </p>
        <p class="muted">
          Los modos económico y manual, con presupuestos y autorización de modelos de pago, se incorporan en una fase
          posterior.
        </p>
      </article>

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
