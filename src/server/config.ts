import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  port: number;
  /** Siempre 127.0.0.1: el servidor no se expone a la red. */
  host: '127.0.0.1';
  dataDir: string;
  providerTimeoutMs: number;
  /** Claves solo en memoria del servidor. */
  secrets: {
    openrouter: string | null;
    opencodeZen: string | null;
  };
}

function readSecret(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`La variable ${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

export function loadEnvFile(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(): AppConfig {
  return {
    port: readInt('PORT', 4317, 1024, 65535),
    host: '127.0.0.1',
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || './data'),
    providerTimeoutMs: readInt('PROVIDER_TIMEOUT_MS', 120_000, 1_000, 600_000),
    secrets: {
      openrouter: readSecret('OPENROUTER_API_KEY'),
      opencodeZen: readSecret('OPENCODE_ZEN_API_KEY'),
    },
  };
}
