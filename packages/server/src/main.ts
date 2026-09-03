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

/** 本地开发默认允许来源（无 CORS_ORIGINS 环境变量时使用） */
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3010', 'http://127.0.0.1:3010'];

/**
 * 解析 CORS 允许来源：从 CORS_ORIGINS 环境变量读取（逗号分隔），
 * 缺省为本地开发来源。绝不使用通配符 `*`（会禁用同源策略）。
 */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CORS_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(',');
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
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

  app.enableCors({ origin: resolveAllowedOrigins(), credentials: true });

  setupSwagger(app);
}

function setupSwagger(app: INestApplication): void {
  if (process.env.NODE_ENV === 'production') return;

  const pkg = readPackageMetadata();
  const config = new DocumentBuilder()
    .setTitle('ZhiHui CodeShield API')
    .setDescription(pkg.description ?? '智汇码盾模块化单体代码治理平台 — NestJS HTTP API')
    .setVersion(pkg.version)
    .setContact('ZhiHui CodeShield', 'https://github.com/zhshield/zhihui-codeshield', '')
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
