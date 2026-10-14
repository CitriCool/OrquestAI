import type { ApiError } from '../api.js';

export function ErrorBanner({ error, onClose }: { error: Pick<ApiError, 'message' | 'action'>; onClose?: () => void }) {
  return (
    <div class="banner error" role="alert">
      <div>
        <strong>{error.message}</strong>
        {error.action && <div class="banner-action">{error.action}</div>}
      </div>
      {onClose && (
        <button class="btn ghost small" onClick={onClose} aria-label="Cerrar aviso">
          Cerrar
        </button>
      )}
    </div>
  );
}
