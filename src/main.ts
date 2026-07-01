import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

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
  });

  const port = process.env.PORT || 3006;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 API MLBB Togo démarrée sur http://localhost:${port}/api`);
}
bootstrap();
