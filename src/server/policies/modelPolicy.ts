import { HttpError } from '../http.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderAdapter } from '../providers/types.js';

/**
 * Devuelve el proveedor si existe, está configurado y, si es externo, el
 * usuario aceptó el aviso de envío de datos. Si no, lanza un HttpError.
 */
export function requireUsableProvider(
  providers: ProviderRegistry,
  consents: { hasConsent(providerId: string): boolean },
  providerId: string,
): ProviderAdapter {
  const provider = providers.get(providerId);
  if (!provider) throw new HttpError(400, 'config', 'El proveedor indicado no existe.', 'Elige un proveedor de la lista.');
  const status = provider.getProviderStatus();
  if (!status.configured) {
    throw new HttpError(400, 'config', `${provider.label} no está configurado.`, status.notes[0] ?? 'Revisa el archivo .env.');
  }
  if (provider.external && !consents.hasConsent(provider.id)) {
    throw new HttpError(
      409,
      'policy',
      `Antes de enviar contenido a ${provider.label} debes aceptar el aviso de envío a un proveedor externo.`,
      'Acepta el aviso en Modelos y proveedores.',
    );
  }
  return provider;
}
