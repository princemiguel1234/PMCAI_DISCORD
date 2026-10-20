import express from 'express';
import { getConfig } from './src/config.js';
import { startDiscordBot } from './src/bot.js';
import { ConversationMemory } from './src/memory.js';

const config = getConfig();
const app = express();
app.disable('x-powered-by');

app.get('/health', (_request, response) => {
  response.status(200).json({
    status: 'ok',
    service: 'PMC_AI',
    note: 'The HTTP process is responsive. This endpoint does not verify Discord, Groq, or Tavily connectivity.',
  });
});

const server = await new Promise((resolve, reject) => {
  const httpServer = app.listen(config.port, '0.0.0.0', () => resolve(httpServer));
  httpServer.once('error', reject);
});
console.log(`[http] Health server listening on 0.0.0.0:${config.port}.`);

const memory = new ConversationMemory({
  ttlMs: config.memoryTtlMs,
  maxConversations: config.maxConversations,
  historyLimit: 25,
});

let client;
let shutdownPromise;

try {
  client = await startDiscordBot(config, memory);
} catch (error) {
  console.error('[startup] PMC_AI failed to start:', String(error?.code ?? error?.name ?? 'startup_error').slice(0, 80));
  memory.stop();
  await closeServer(server);
  process.exitCode = 1;
}

async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[shutdown] Received ${signal}; closing PMC_AI.`);
    memory.stop();
    if (client) client.destroy();
    await closeServer(server);
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

function closeServer(httpServer) {
  return new Promise((resolve) => {
    if (!httpServer?.listening) return resolve();
    httpServer.close(() => resolve());
    httpServer.closeIdleConnections?.();
  });
}
