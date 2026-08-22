import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

interface PackageMetadata {
  name: string;
  version: string;
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** __dirname 在编译后为 dist/，package.json 位于包根（上一级） */
function readPackageMetadata(): PackageMetadata {
  const raw: unknown = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.version !== 'string') {
    throw new Error('packages/server/package.json 缺少 name/version 字段');
  }
  return {
    name: raw.name,
    version: raw.version,
    description: typeof raw.description === 'string' ? raw.description : undefined,
  };
}

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

  setupSwagger(app);
}

function setupSwagger(app: INestApplication): void {
  if (process.env.NODE_ENV === 'production') return;

  const pkg = readPackageMetadata();
  const config = new DocumentBuilder()
    .setTitle('ZhiYan CodeShield API')
    .setDescription(pkg.description ?? '智汇码盾模块化单体代码治理平台 — NestJS HTTP API')
    .setVersion(pkg.version)
    .setContact('ZhiYan CodeShield', 'https://github.com/zhshield/zhiyan-codeshield', '')
    .addServer(`http://localhost:${process.env.PORT ?? 3010}/api/v1`, 'Local development')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}

async function startServer(app: INestApplication): Promise<void> {
  const port = process.env.PORT ?? 3010;
  await app.listen(port);

  Logger.log(`智汇码盾服务端运行在 http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
