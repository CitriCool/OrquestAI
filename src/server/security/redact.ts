/**
 * Redacción de secretos. Se aplica a todo texto que pueda acabar en logs,
 * respuestas de error o la base de datos.
 */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

/** Solo para pruebas. */
export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_\-]{16,}/g, // formato habitual de claves (OpenRouter: sk-or-...)
  /Bearer\s+[A-Za-z0-9._\-]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets) {
    out = out.split(secret).join('[REDACTADO]');
  }
  for (const re of PATTERNS) out = out.replace(re, '[REDACTADO]');
  return out;
}

export const log = {
  info(msg: string): void {
    console.log(`[info] ${redact(msg)}`);
  },
  warn(msg: string): void {
    console.warn(`[aviso] ${redact(msg)}`);
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : err ? String(err) : '';
    console.error(`[error] ${redact(msg)}${detail ? ` ${redact(detail)}` : ''}`);
  },
};
