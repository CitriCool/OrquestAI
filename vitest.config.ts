import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Las pruebas nunca deben llamar a proveedores reales.
    env: {
      OPENROUTER_API_KEY: '',
      OPENCODE_ZEN_API_KEY: '',
    },
  },
});
