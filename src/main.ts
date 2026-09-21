import { createApp } from './bootstrap';

async function bootstrap() {
  const app = await createApp();

  // Close the app (and therefore disconnect Prisma) on SIGTERM/SIGINT instead
  // of dropping the process with open connections.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3006;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 API MLBB Togo démarrée sur http://localhost:${port}/api`);
}
bootstrap();
