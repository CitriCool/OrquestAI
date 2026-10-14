import type { CostClass } from './schemas.js';

/**
 * Precios en USD tal como los publica el proveedor: por token (prompt,
 * completion) y por solicitud (request). Fuente: documentación de OpenRouter,
 * consultada el 14-10-2026 («All pricing values are in USD per token/request/unit»).
 */
export interface ModelPricing {
  prompt: number;
  completion: number;
  request: number;
}

const PER_MILLION = 1_000_000;

/**
 * Umbrales de la aplicación (no del proveedor) para clasificar el coste,
 * en USD por millón de tokens de salida, que suele ser el precio dominante.
 */
export const COST_THRESHOLDS = {
  /** Hasta este precio de salida, el modelo es «económico». */
  lowMaxCompletionPerM: 2,
  /** Desde este precio de salida, el modelo es «de pago (alto)». */
  premiumMinCompletionPerM: 15,
} as const;

export function classifyPricing(p: ModelPricing): Exclude<CostClass, 'unknown'> {
  if (p.prompt === 0 && p.completion === 0 && p.request === 0) return 'free';
  const completionPerM = p.completion * PER_MILLION;
  if (completionPerM <= COST_THRESHOLDS.lowMaxCompletionPerM) return 'low';
  if (completionPerM >= COST_THRESHOLDS.premiumMinCompletionPerM) return 'premium';
  return 'standard';
}

/**
 * Tokens de entrada estimados a partir de los caracteres. Se usan 3
 * caracteres por token (más tokens que el promedio habitual) para que la
 * estimación quede por encima del coste real, no por debajo.
 */
export function estimateInputTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

/**
 * Coste máximo estimado de una llamada: toda la entrada y el máximo de
 * salida permitido. Es una cota superior, nunca un coste real.
 */
export function estimateCallCost(p: ModelPricing, inputChars: number, maxOutputTokens: number): number {
  return p.prompt * estimateInputTokens(inputChars) + p.completion * maxOutputTokens + p.request;
}

/** Precio por millón de tokens, para mostrarlo. */
export function perMillion(pricePerToken: number): number {
  return pricePerToken * PER_MILLION;
}

export function formatUsd(amount: number): string {
  if (amount === 0) return 'USD 0';
  if (amount < 0.01) return `USD ${amount.toFixed(4)}`;
  return `USD ${amount.toFixed(2)}`;
}
