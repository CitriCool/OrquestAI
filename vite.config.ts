import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const apiPort = Number(process.env.PORT ?? 4317);

export default defineConfig({
  root: 'src/client',
  plugins: [preact()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        // Mantiene Host/Origin del navegador para que el guardián local los valide.
        changeOrigin: false,
      },
    },
  },
});
