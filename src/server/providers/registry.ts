import type { AppConfig } from '../config.js';
import { createMockProvider } from './mock.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';
import type { ProviderAdapter } from './types.js';

export type ProviderRegistry = Map<string, ProviderAdapter>;

/**
 * Proveedores disponibles. Los datos de modelos que no se obtienen del
 * propio proveedor indican su fuente y la fecha en que se verificaron.
 */
export function createProviderRegistry(config: AppConfig, extra: ProviderAdapter[] = []): ProviderRegistry {
  const providers: ProviderAdapter[] = [
    createMockProvider(),
    createOpenAICompatibleProvider({
      id: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: config.secrets.openrouter,
      apiKeyEnvName: 'OPENROUTER_API_KEY',
      pricingFromModelList: true,
      extraHeaders: { 'X-Title': 'OrquestAI' },
      notes: [
        'La clasificación gratuita sale del precio que informa OpenRouter en su listado (precio 0). Puede cambiar sin aviso.',
        'Algunos modelos gratuitos exigen activar opciones de privacidad en tu cuenta de OpenRouter.',
      ],
    }),
    createOpenAICompatibleProvider({
      id: 'opencode-zen',
      label: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/inference/v1',
      apiKey: config.secrets.opencodeZen,
      apiKeyEnvName: 'OPENCODE_ZEN_API_KEY',
      requestStreamUsage: true,
      knownModels: [
        {
          id: 'big-pickle',
          name: 'Big Pickle',
          costClass: 'free',
          costSource:
            'Documentación de OpenCode Zen: gratuito por tiempo limitado. Durante ese periodo los datos enviados pueden usarse para mejorar el modelo.',
          verifiedAt: '2026-10-14',
        },
      ],
      notes: [
        'Big Pickle es gratuito por tiempo limitado y tus datos pueden usarse para mejorar el modelo durante ese periodo.',
        'Los precios de los demás modelos de Zen no se leen automáticamente; se tratan como de coste desconocido.',
      ],
    }),
    ...extra,
  ];
  return new Map(providers.map((p) => [p.id, p]));
}
