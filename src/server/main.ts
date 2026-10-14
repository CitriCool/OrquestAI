import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import { createProviderRegistry } from './providers/registry.js';
import { allowedHosts, createSessionToken } from './security/localGuard.js';
import { log, registerSecret } from './security/redact.js';
import { openDatabase } from './storage/db.js';
import { Repository } from './storage/repository.js';
import { TaskRepository } from './storage/taskRepository.js';

loadEnvFile();
const config = loadConfig();
registerSecret(config.secrets.openrouter);
registerSecret(config.secrets.opencodeZen);

const db = openDatabase(path.join(config.dataDir, 'orquestai.db'));
const repo = new Repository(db);
const recovered = repo.recoverInterruptedMessages();
if (recovered > 0) log.info(`Se marcaron ${recovered} respuesta(s) interrumpida(s) por el cierre anterior.`);
const recoveredTasks = new TaskRepository(db).recoverInterruptedTasks();
if (recoveredTasks > 0) log.info(`Se recuperaron ${recoveredTasks} tarea(s) interrumpida(s) por el cierre anterior.`);

const app = createApp({
  repo,
  providers: createProviderRegistry(config),
  token: createSessionToken(),
  allowedHosts: allowedHosts(config.port),
  providerTimeoutMs: config.providerTimeoutMs,
  taskCallTimeoutMs: config.taskCallTimeoutMs,
});

// Interfaz compilada (npm run build). En desarrollo la sirve Vite.
const clientDir = path.resolve('dist/client');
if (existsSync(path.join(clientDir, 'index.html'))) {
  const indexHtml = readFileSync(path.join(clientDir, 'index.html'), 'utf8');
  app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), clientDir) }));
  app.get('*', (c) => c.html(indexHtml));
} else {
  app.get('*', (c) =>
    c.text('La interfaz no está compilada. Ejecuta "npm start" o usa "npm run dev" y abre http://127.0.0.1:5173.', 503),
  );
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info(`OrquestAI escuchando en http://${config.host}:${info.port}`);
});

function shutdown() {
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
