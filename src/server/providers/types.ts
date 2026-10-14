import type { ErrorKind, ModelInfo, Usage } from '../../shared/schemas.js';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  modelId: string;
  messages: ChatTurn[];
  maxOutputTokens?: number;
  /** Cancelación por el usuario. */
  signal: AbortSignal;
  timeoutMs: number;
  /** Si se indica, la respuesta se recibe en fragmentos. */
  onDelta?: (text: string) => void;
}

export interface GenerateResponse {
  text: string;
  finishReason: string | null;
  /** Uso tal como lo devolvió el proveedor, sin interpretar. */
  rawUsage: unknown;
}

export type Support = 'supported' | 'unsupported' | 'unknown';

export interface ModelCapabilities {
  contextLength: number | null;
  streaming: Support;
  structuredOutput: Support;
}

export interface CostEstimate {
  cost: number | null;
  kind: 'estimated' | 'unknown';
}

export class ProviderError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly action: string,
    readonly opts: { status?: number; retryAfterMs?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.opts.retryable ?? false;
  }
}

/**
 * Contrato común de todos los proveedores. Las capacidades desconocidas
 * se devuelven como 'unknown' o 'unsupported', nunca se suponen.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  /** true si el contenido sale del equipo hacia un servicio externo. */
  readonly external: boolean;

  generateResponse(request: GenerateRequest): Promise<GenerateResponse>;
  getProviderStatus(): { configured: boolean; notes: string[] };
  classifyProviderError(error: unknown): ProviderError;
  getModelCapabilities(modelId: string): Promise<ModelCapabilities>;
  supportsStructuredOutput(modelId: string): Promise<Support>;
  estimateCost(request: Pick<GenerateRequest, 'modelId' | 'messages' | 'maxOutputTokens'>): Promise<CostEstimate>;
  getReportedUsage(response: GenerateResponse): Usage;
  listModels(): Promise<ModelInfo[]>;
}
