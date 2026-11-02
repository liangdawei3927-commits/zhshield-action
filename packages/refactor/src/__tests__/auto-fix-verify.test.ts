import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RefactorEngine } from '../engine';
import { collectProjectErrors, newErrorsSince } from '../auto-fix-verify';

// tsc 程序构建在 CI 慢机上可能偏慢，统一放宽超时
const T = 30000;

function writeTsconfig(root: string): void {
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true, skipLibCheck: true },
        include: ['*.ts'],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

const FOO_PUBLIC =
  'export class Foo {\n' +
  '  public a: number = 1;\n' +
  '  public b: number = 2;\n' +
  '  public c: number = 3;\n' +
  '  public d: number = 4;\n' +
  '}\n';

describe('collectProjectErrors', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('无 tsconfig → 返回 null（fail-open）', () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const x: number = 1;\n');
    expect(collectProjectErrors(root)).toBeNull();
  }, T);

  it('有 tsconfig 的干净项目 → 空错误集合', () => {
    writeTsconfig(root);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const x: number = 1;\n');
    const errs = collectProjectErrors(root);
    expect(errs).not.toBeNull();
    expect([...(errs as Set<string>)]).toEqual([]);
  }, T);

  it('有类型错误的项目 → 集合含该文件错误', () => {
    writeTsconfig(root);
    fs.writeFileSync(path.join(root, 'bad.ts'), 'export const x: number = "oops";\n');
    const errs = collectProjectErrors(root) as Set<string>;
    expect([...errs].some((e) => e.includes('bad.ts'))).toBe(true);
  }, T);
});

describe('newErrorsSince', () => {
  it('返回 after 相对 before 的新增项', () => {
    expect(newErrorsSince(new Set(['a::1::x']), new Set(['a::1::x', 'b::2::y']))).toEqual([
      'b::2::y',
    ]);
  });
  it('无新增 → 空数组', () => {
    const s = new Set(['a::1::x']);
    expect(newErrorsSince(s, s)).toEqual([]);
  });
});

describe('applyAutoFixes 编译校验-回滚（P1-2）', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-verify-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('修复会破坏外部引用 → 整体回滚，文件恢复为 public', async () => {
    writeTsconfig(root);
    fs.writeFileSync(path.join(root, 'foo.ts'), FOO_PUBLIC, 'utf-8');
    fs.writeFileSync(
      path.join(root, 'use.ts'),
      "import { Foo } from './foo';\nconst f = new Foo();\nexport const v = f.a;\n",
      'utf-8',
    );

    const result = await new RefactorEngine().applyAutoFixes(root);

    expect(result.applied).toBe(false);
    expect(result.errors.join('\n')).toContain('回滚');
    expect(fs.readFileSync(path.join(root, 'foo.ts'), 'utf-8')).toBe(FOO_PUBLIC);
  }, T);

  it('修复不破坏外部引用 → 正常应用', async () => {
    writeTsconfig(root);
    fs.writeFileSync(path.join(root, 'foo.ts'), FOO_PUBLIC, 'utf-8');

    const result = await new RefactorEngine().applyAutoFixes(root);

    expect(result.applied).toBe(true);
    expect(fs.readFileSync(path.join(root, 'foo.ts'), 'utf-8')).toContain('private a');
  }, T);
});
