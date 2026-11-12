import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SecurityCheckEngine } from '../security-check-engine';

/**
 * 安全配置类检测（安全响应头 / 认证会话 / 审计日志 / 密钥轮换 / 供应链签名）的验收用例。
 *
 * 锁定的不变量：
 *   1. 无对应检测面时必须是 not-applicable，不得用 passed 冒充「已验证」；
 *   2. 有检测面但未检出机制 → failed（真实缺口），文案写明源码模式的边界；
 *   3. 关闭保护（如 contentSecurityPolicy: false）与弱配置（HSTS < 180 天）必须判失败。
 */
describe('SecurityCheckEngine — 安全配置类检测', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zh-security-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  function writeDeps(deps: Record<string, string>, scripts: Record<string, string> = {}): void {
    write('package.json', JSON.stringify({ name: 'fixture', dependencies: deps, scripts }));
  }

  async function runCheck(check: string) {
    const { results } = await new SecurityCheckEngine().run({
      mode: 'security',
      target: dir,
      checks: [check],
      dryRun: false,
    });
    const result = results[0];
    if (!result) throw new Error(`未返回检测结果: ${check}`);
    return result;
  }

  describe('安全响应头', () => {
    it('无 Web 框架 → 三项响应头检查均为 not-applicable', async () => {
      writeDeps({ 'left-pad': '1.0.0' });
      for (const check of [
        'header-content-security-policy',
        'header-hsts',
        'header-frame-options',
      ]) {
        const result = await runCheck(check);
        expect(result.applicability).toBe('not-applicable');
        expect(result.message).toContain('没有装配位置');
      }
    });

    it('helmet() 默认策略 → 通过（依赖已装但没有装配调用则失败）', async () => {
      writeDeps({ express: '4.0.0', helmet: '7.0.0' });
      write('src/app.ts', 'app.use(helmet());');
      const csp = await runCheck('header-content-security-policy');
      expect(csp.status).toBe('passed');
      expect(csp.applicability).toBeUndefined();
    });

    it('只有 helmet 依赖、没有装配调用 → 失败', async () => {
      writeDeps({ express: '4.0.0', helmet: '7.0.0' });
      write('src/app.ts', "import helmet from 'helmet';");
      const frame = await runCheck('header-frame-options');
      expect(frame.status).toBe('failed');
      expect(frame.message).toContain('未检出装配调用');
    });

    it('显式关闭 CSP → 失败，不被 helmet() 默认启用掩盖', async () => {
      writeDeps({ express: '4.0.0', helmet: '7.0.0' });
      write('src/app.ts', 'app.use(helmet({ contentSecurityPolicy: false }));');
      const csp = await runCheck('header-content-security-policy');
      expect(csp.status).toBe('failed');
      expect(csp.message).toContain('显式关闭');
    });

    it('HSTS maxAge 低于 180 天 → 失败', async () => {
      writeDeps({ express: '4.0.0', helmet: '7.0.0' });
      write('src/app.ts', 'app.use(helmet({ strictTransportSecurity: { maxAge: 3600 } }));');
      const hsts = await runCheck('header-hsts');
      expect(hsts.status).toBe('failed');
      expect(hsts.message).toContain('180 天');
    });

    it('Set-Cookie 的 Max-Age=0 不算 HSTS 弱配置（删 Cookie ≠ 有效期 0）', async () => {
      writeDeps({ express: '4.0.0', helmet: '7.0.0' });
      write('src/app.ts', 'app.use(helmet());');
      write('src/logout.ts', "res.setHeader('Set-Cookie', 'zh_admin=; HttpOnly; Max-Age=0');");
      const hsts = await runCheck('header-hsts');
      expect(hsts.status).toBe('passed');
    });

    it('显式头配置取值达标（max-age=31536000）→ 通过', async () => {
      writeDeps({ express: '4.0.0' });
      write('src/app.ts', "res.setHeader('Strict-Transport-Security', 'max-age=31536000');");
      const hsts = await runCheck('header-hsts');
      expect(hsts.status).toBe('passed');
      expect(hsts.message).toContain('检出 HSTS 配置');
    });
  });

  describe('认证与会话', () => {
    it('未使用认证库 → not-applicable', async () => {
      writeDeps({ express: '4.0.0' });
      const cookie = await runCheck('session-cookie-flags');
      expect(cookie.applicability).toBe('not-applicable');
    });

    it('Cookie 三项属性齐全 → 通过；缺 secure → 失败', async () => {
      writeDeps({ express: '4.0.0', 'express-session': '1.0.0' });
      write('src/session.ts', "const opts = { httpOnly: true, secure: true, sameSite: 'lax' };");
      const ok = await runCheck('session-cookie-flags');
      expect(ok.status).toBe('passed');
      expect(ok.message).toContain('httpOnly');
    });

    it('JWT 缺少 expiresIn → 失败；有 expiresIn → 通过', async () => {
      writeDeps({ jsonwebtoken: '9.0.0' });
      write('src/token.ts', 'jwt.sign(payload, secret);');
      const missing = await runCheck('token-expiry');
      expect(missing.status).toBe('failed');
      expect(missing.message).toContain('expiresIn');
    });

    it('密码哈希调用 → 通过；没有哈希调用 → 失败', async () => {
      writeDeps({ bcryptjs: '2.4.3' });
      write('src/user.ts', 'const hash = await bcrypt.hash(password, 10);');
      const ok = await runCheck('password-hashing');
      expect(ok.status).toBe('passed');
      write('src/user.ts', 'const hash = password;');
      // 重写后新扫描仍会读到旧证据之外的同一文件（bcrypt.hash 行已删除）
      const missing = await runCheck('password-hashing');
      expect(missing.status).toBe('failed');
    });
  });

  describe('审计日志', () => {
    it('无服务端/日志面 → not-applicable', async () => {
      writeDeps({ 'left-pad': '1.0.0' });
      const audit = await runCheck('audit-log-events');
      expect(audit.applicability).toBe('not-applicable');
    });

    it('服务端但未检出审计日志 → 失败；检出登录失败日志 → 通过', async () => {
      writeDeps({ express: '4.0.0' });
      write('src/app.ts', 'app.get("/health", handler);');
      const missing = await runCheck('audit-log-events');
      expect(missing.status).toBe('failed');

      write('src/auth.ts', 'logger.warn("login failed for user", userId);');
      const ok = await runCheck('audit-log-events');
      expect(ok.status).toBe('passed');
      expect(ok.message).toContain('审计日志');
    });
  });

  describe('密钥生命周期', () => {
    it('项目不使用密钥材料 → not-applicable', async () => {
      writeDeps({ 'left-pad': '1.0.0' });
      const rotation = await runCheck('key-rotation-mechanism');
      expect(rotation.applicability).toBe('not-applicable');
    });

    it('只有 timingSafeEqual（常量时间比较）→ 不算密钥材料，判 not-applicable', async () => {
      writeDeps({ 'left-pad': '1.0.0' });
      write('src/token.ts', 'return crypto.timingSafeEqual(left, right);');
      const rotation = await runCheck('key-rotation-mechanism');
      expect(rotation.applicability).toBe('not-applicable');
    });

    it('使用 crypto 但未检出轮换 → 失败；有 keyVersion → 通过', async () => {
      write('src/crypto.ts', 'const mac = createHmac("sha256", key);');
      const missing = await runCheck('key-rotation-mechanism');
      expect(missing.status).toBe('failed');

      write('src/keys.ts', 'const keyVersion = 2;');
      const ok = await runCheck('key-rotation-mechanism');
      expect(ok.status).toBe('passed');
    });

    it('未检出 KMS/Vault → 失败；检出集中密钥管理 → 通过', async () => {
      writeDeps({ '@aws-sdk/client-kms': '3.0.0' });
      const missing = await runCheck('key-management-service');
      expect(missing.status).toBe('failed');

      write('src/kms.ts', "import { KMSClient } from '@aws-sdk/client-kms';");
      const ok = await runCheck('key-management-service');
      expect(ok.status).toBe('passed');
    });
  });

  describe('供应链签名', () => {
    it('无依赖清单 → not-applicable', async () => {
      const signature = await runCheck('supply-signature-verification');
      expect(signature.applicability).toBe('not-applicable');
    });

    it('有依赖但无校验命令 → 失败；CI workflow 检出 npm audit signatures → 通过', async () => {
      writeDeps({ 'left-pad': '1.0.0' });
      const missing = await runCheck('supply-signature-verification');
      expect(missing.status).toBe('failed');

      write('.github/workflows/ci.yml', 'run: npm audit signatures');
      const ok = await runCheck('supply-signature-verification');
      expect(ok.status).toBe('passed');
      expect(ok.message).toContain('.github/workflows/ci.yml');
    });

    it('package.json scripts 里的签名校验命令同样算证据', async () => {
      writeDeps({ 'left-pad': '1.0.0' }, { verify: 'npm audit signatures' });
      const ok = await runCheck('supply-signature-verification');
      expect(ok.status).toBe('passed');
    });

    it('内嵌独立仓库的 CI workflow 也算证据（源码可下探时 CI 不能漏扫）', async () => {
      writeDeps({ 'left-pad': '1.0.0' });
      write('nested/.github/workflows/release.yml', 'uses: actions/attest-build-provenance@v2');
      const ok = await runCheck('supply-signature-verification');
      expect(ok.status).toBe('passed');
      expect(ok.message).toContain('nested/.github/workflows/release.yml');
    });
  });
});
