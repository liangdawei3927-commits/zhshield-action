import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSopBase } from '@zh/kernel';
import { readBooleanEnv } from './env-flag';

/**
 * 云端规则同步的**入口参数解析** —— 只回答「连哪个云、用什么令牌、拿什么公钥验签」，
 * 一个请求都不发（网络动作在 sop-remote-sync.ts）。
 *
 * 为什么要独立成模块：这几个参数是 CI 里最容易配错、也最容易「配错了还静默跑通」的东西。
 *   · 令牌配错 → 服务端 401 → 归因成 http_error，能看见；
 *   · 公钥配错 → 验签不过 → 归因成 signature_rejected，也能看见；
 *   · **公钥没配** → 若代码里默认「不验签放行」，就变成永远绿灯（形态①的信任版）。
 * 所以这里对每个缺失项都产出人话原因，由调用方决定是降级还是拒绝，绝不内部吞掉。
 */

/** 云端规则同步的 API 令牌（CI 里用 secret 注入） */
export const SOP_TOKEN_ENV = 'ZH_SOP_API_TOKEN';
/** 验签公钥：PEM 字面量，或 PEM 文件路径 */
export const SOP_PUBLIC_KEY_ENV = 'ZH_SOP_PUBLIC_KEY';
/** 放行未签名规则（内网自建服务端没有签名密钥时的逃生口，默认关闭） */
export const ALLOW_UNSIGNED_ENV = 'ZH_SOP_ALLOW_UNSIGNED';

/** 令牌文件（与 LocalOnlyGuard / 桌面端同一份，此处置为只读，绝不在 CI 里凭空生成） */
const TOKEN_FILE = path.join('.zhshield', '.api-token');

/** 解析结果：所有字段都有来源说明，`problems` 是「配了但不对」的清单 */
export interface SopRemoteSettings {
  /** 规则接口基址（形如 https://host/api/v1/sop，已剥尾斜杠） */
  readonly sopBase: string;
  /** 令牌来源说明（进输出，便于确认 CI 的 secret 真的注入进来了） */
  readonly tokenSource: string;
  readonly token?: string;
  readonly publicKeySource: string;
  readonly publicKey?: string;
  /** 是否允许采纳未签名规则 */
  readonly allowUnsigned: boolean;
  /** 配置层面的问题（非致命：公钥缺失还会去服务端取） */
  readonly problems: readonly string[];
}

export interface SopRemoteEnvInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

/**
 * 读取令牌：环境变量优先，其次令牌文件（只读）。
 *
 * **不在文件缺失时生成新令牌** —— kernel 的 `readApiToken()` 会顺手写一份随机令牌，
 * 那是给本地后端 LocalOnlyGuard 用的。CI 里凭空生成一个令牌只会让 401 更难理解：
 * 你以为在用 secret，实际用的是刚造的随机串。
 */
export function readCloudToken(input: SopRemoteEnvInput): {
  token?: string;
  source: string;
} {
  const fromEnv = input.env[SOP_TOKEN_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: `环境变量 ${SOP_TOKEN_ENV}` };

  const file = path.join(input.homeDir, TOKEN_FILE);
  try {
    const content = fs.readFileSync(file, 'utf-8').trim();
    if (content) return { token: content, source: `令牌文件 ${file}` };
  } catch {
    // 文件不存在属正常（服务端未开鉴权的自建部署）
  }
  return { source: `未提供（${SOP_TOKEN_ENV} 未设，且 ${file} 不存在）` };
}

/**
 * 解析公钥：PEM 字面量 → 文件路径。
 *
 * 判据用「内容里有没有 PEM 头」而不是「是不是以 / 开头」，因为 CI 里最常见的写法
 * 是把多行 PEM 直接塞进 secret（含换行、含首尾空格），路径判据会把它当文件名去读盘。
 */
export function resolvePublicKeyMaterial(raw: string, homeDir: string): {
  key?: string;
  problem?: string;
} {
  const value = raw.trim();
  if (value.includes('BEGIN PUBLIC KEY')) return { key: value };

  const file = path.isAbsolute(value) ? value : path.join(homeDir, value);
  try {
    const content = fs.readFileSync(file, 'utf-8').trim();
    if (!content.includes('BEGIN PUBLIC KEY')) {
      return { problem: `${SOP_PUBLIC_KEY_ENV} 指向的文件不含 PEM 公钥: ${file}` };
    }
    return { key: content };
  } catch {
    return { problem: `${SOP_PUBLIC_KEY_ENV} 既不是 PEM 字面量，也读不到文件: ${file}` };
  }
}

/** 解析全部入口参数（纯函数式：环境全部显式传入，用例无需改真机环境） */
export function resolveSopRemoteSettings(input: SopRemoteEnvInput): SopRemoteSettings {
  const problems: string[] = [];
  const token = readCloudToken(input);
  const publicKey = resolvePublicKey(input, problems);

  return {
    sopBase: resolveSopBase(),
    tokenSource: token.source,
    ...(token.token !== undefined ? { token: token.token } : {}),
    publicKeySource: publicKey.source,
    ...(publicKey.key !== undefined ? { publicKey: publicKey.key } : {}),
    allowUnsigned: readBooleanEnv(input.env, ALLOW_UNSIGNED_ENV),
    problems,
  };
}

/** 公钥解析：显式给出 → 解析；未给出 → 占位说明（调用方再去服务端 /public-key 取） */
function resolvePublicKey(
  input: SopRemoteEnvInput,
  problems: string[],
): { key?: string; source: string } {
  const raw = input.env[SOP_PUBLIC_KEY_ENV];
  if (raw?.trim()) {
    const resolved = resolvePublicKeyMaterial(raw, input.homeDir);
    if (resolved.problem) problems.push(resolved.problem);
    return { ...(resolved.key !== undefined ? { key: resolved.key } : {}), source: SOP_PUBLIC_KEY_ENV };
  }
  return { source: `未设置（将从服务端 /sop/public-key 获取）` };
}

/** 取真实环境（生产路径专用；用例请构造 SopRemoteEnvInput） */
export function currentSopRemoteEnv(): SopRemoteEnvInput {
  return { env: process.env, homeDir: os.homedir() };
}
