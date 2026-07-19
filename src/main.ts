import { setDefaultResultOrder } from 'node:dns';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

// Prefer IPv4 when resolving hostnames. Node's fetch (undici) otherwise tries
// IPv6 first and fails with an opaque "fetch failed" on machines/networks with
// broken IPv6 (a common cause of Google userinfo failures on login).
setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.enableCors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3005',
      'http://localhost:3005',
    ],
    credentials: true,
    // Cache the OPTIONS preflight for 24h in the browser -> far fewer 204s.
    maxAge: 86400,
  });

  const port = process.env.PORT || 3006;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 API MLBB Togo démarrée sur http://localhost:${port}/api`);
}
bootstrap();
