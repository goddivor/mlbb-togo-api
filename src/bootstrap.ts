import { setDefaultResultOrder } from 'node:dns';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './community/redis-io.adapter';

// Prefer IPv4 when resolving hostnames. Node's fetch (undici) otherwise tries
// IPv6 first and fails with an opaque "fetch failed" on machines/networks with
// broken IPv6 (a common cause of Google userinfo failures on login).
setDefaultResultOrder('ipv4first');

/**
 * Origins always allowed, whatever the host: the configured frontend and the
 * local development server.
 */
export function staticAllowedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [env.FRONTEND_URL || 'http://localhost:3005', 'http://localhost:3005'];
}

/**
 * CORS origin check. Keeps the historical behaviour (FRONTEND_URL and
 * localhost:3005) and additionally accepts any localhost port and any Vercel
 * preview deployment, so preview frontends can talk to the API.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Same-origin / server-to-server requests send no Origin header.
  if (!origin) return true;
  if (staticAllowedOrigins(env).includes(origin)) return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return true;
  }
  return host === 'vercel.app' || host.endsWith('.vercel.app');
}

/**
 * Applies every piece of configuration shared by the standalone server
 * (`src/main.ts`) and the serverless entrypoint (`api/index.ts`).
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.enableCors({
    origin: (origin: string | undefined, callback: CorsCallback) =>
      callback(null, isAllowedOrigin(origin)),
    credentials: true,
    // Cache the OPTIONS preflight for 24h in the browser -> far fewer 204s.
    maxAge: 86400,
  });
}

type CorsCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Creates and configures the Nest application, wiring the socket.io Redis
 * adapter when a Redis URL is available. The application is not started: the
 * caller decides between `listen()` (standalone) and `init()` (serverless).
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);

  const wsAdapter = new RedisIoAdapter(app);
  await wsAdapter.connect();
  app.useWebSocketAdapter(wsAdapter);

  configureApp(app);

  return app;
}
