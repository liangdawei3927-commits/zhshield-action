import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { translate, DEFAULT_LANGUAGE } from '@zh/i18n';
import * as path from 'path';
import { AppModule } from './app.module';
import { ScoringService } from './scoring/scoring.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureApp(app);
  setupSwagger(app);
  await enableScoringPersistence(app);
  await startServer(app);
}

/** 评分数据落库到 SQLite（ZH_DB_PATH 可覆盖默认路径），失败降级为内存模式 */
async function enableScoringPersistence(app: INestApplication): Promise<void> {
  const dbPath = process.env.ZH_DB_PATH ?? path.join(process.cwd(), '.zhshield', 'data', 'zhiyan-server.db');
  await app.get(ScoringService).initialize(dbPath);
}

function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'ready', 'live', 'metrics'],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.enableCors({ origin: '*', credentials: true });
}

function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('智汇码盾 API')
    .setDescription('ZHCodeShield治理引擎API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);
}

async function startServer(app: INestApplication): Promise<void> {
  const port = process.env.PORT ?? 3010;
  await app.listen(port);

  Logger.log(translate('server.bootstrap.running', DEFAULT_LANGUAGE, { port }), 'Bootstrap');
}

void bootstrap();
