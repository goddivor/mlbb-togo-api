import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createApp } from '../src/bootstrap';

/**
 * Vercel serverless entrypoint.
 *
 * Vercel's Node runtime supports WebSockets only when the module's default
 * export is the underlying HTTP server (https://vercel.com/docs/functions/websockets),
 * which has to be available synchronously. Nest, on the other hand, boots
 * asynchronously. So we export a bare HTTP server straight away and forward its
 * `request` / `upgrade` events to Nest's own HTTP server once it is ready.
 *
 * The bootstrap promise is module-scoped, so a warm instance reuses the very
 * same Nest application (and its Prisma connection pool) across invocations.
 */
let nestServerPromise: Promise<Server> | null = null;

function bootNestServer(): Promise<Server> {
  if (!nestServerPromise) {
    nestServerPromise = createApp()
      .then(async (app) => {
        // `init()` wires the HTTP routes and the websocket gateways without
        // binding a port, which is what a serverless function needs.
        await app.init();
        return app.getHttpServer() as Server;
      })
      .catch((error) => {
        // Let the next invocation retry instead of caching a failed boot.
        nestServerPromise = null;
        throw error;
      });
  }
  return nestServerPromise;
}

const server = createServer();

server.on('request', (req: IncomingMessage, res: ServerResponse) => {
  bootNestServer().then(
    (nest) => nest.emit('request', req, res),
    (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Nest bootstrap failed', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
      }
      res.end(JSON.stringify({ statusCode: 500, message: 'Bootstrap failed' }));
    },
  );
});

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  bootNestServer().then(
    (nest) => nest.emit('upgrade', req, socket, head),
    () => socket.destroy(),
  );
});

// Warm the application up as soon as the module is loaded.
void bootNestServer().catch(() => undefined);

export default server;
