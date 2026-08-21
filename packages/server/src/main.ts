import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureApp(app);
  await startServer(app);
}

function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'ready', 'live', 'metrics'],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.enableCors({ origin: '*', credentials: true });
}

async function startServer(app: INestApplication): Promise<void> {
  const port = process.env.PORT ?? 3010;
  await app.listen(port);

  Logger.log(`智汇码盾服务端运行在 http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
