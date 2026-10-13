/**
 * 项目画像基础类型（跨包共享的单一事实源）。
 *
 * 此前 @zh/pipeline 与 @zh/dependency 各声明一份形状相同的 ProjectLanguage /
 * PackageManager / ProjectProfile，被 jscpd 判为重复代码；两包均已依赖 @zh/shared，
 * 故上移至此作为唯一定义，两包各自 re-export，保持既有公开 API 与类型形状不变。
 */

/** 项目语言（JS/TS 走 package.json 判定，Python 走清单信号判定） */
export type ProjectLanguage = 'typescript' | 'javascript' | 'python' | 'unknown';

/** 包管理器（JS 侧按锁文件判定，Python 侧按 poetry/uv/Pipfile 等锁定文件判定） */
export type PackageManager =
  'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry' | 'uv' | 'pipenv' | 'unknown';

/** 项目画像：语言、框架、包管理器与是否含 TypeScript（供流水线选择应启用的域） */
export interface ProjectProfile {
  projectPath: string;
  language: ProjectLanguage;
  framework: string | null;
  packageManager: PackageManager;
  hasTypeScript: boolean;
}
