import type { ModelInfo } from '../../shared/schemas.js';
import { HttpError } from '../http.js';
import type { ProviderAdapter } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';

/**
 * Política de la Fase 1: solo se permiten modelos clasificados como gratuitos
 * (modo A). Los modelos de pago se habilitarán en la Fase 3, con presupuestos
 * y autorización explícita. La comprobación ocurre siempre en el servidor.
 */
export async function assertModelAllowed(provider: ProviderAdapter, modelId: string): Promise<ModelInfo> {
  let models: ModelInfo[];
  try {
    models = await provider.listModels();
  } catch (err) {
    const e = err instanceof ProviderError ? err : provider.classifyProviderError(err);
    throw new HttpError(
      502,
      e.kind,
      `No se pudo comprobar el coste del modelo: ${e.message}`,
      `${e.action} Sin esa comprobación no se envía la solicitud.`,
    );
  }
  const model = models.find((m) => m.id === modelId);
  if (!model) {
    throw new HttpError(
      400,
      'model_unavailable',
      `El modelo "${modelId}" no aparece en el listado de ${provider.label}.`,
      'Elige otro modelo en Modelos y proveedores.',
    );
  }
  if (model.restriction) {
    throw new HttpError(
      403,
      'policy',
      `El modelo "${modelId}" no se puede usar desde esta aplicación: ${model.restriction}`,
      'Elige otro modelo gratuito, por ejemplo uno de OpenRouter.',
    );
  }
  if (model.costClass !== 'free') {
    const reason =
      model.costClass === 'unknown' ? 'no tiene una clasificación de coste verificable' : 'no es gratuito';
    throw new HttpError(
      403,
      'policy',
      `El modelo "${modelId}" ${reason}. En esta versión solo se permiten modelos gratuitos.`,
      'Elige un modelo marcado como gratuito. Los modelos de pago se podrán autorizar con presupuesto en una fase posterior.',
    );
  }
  return model;
}
