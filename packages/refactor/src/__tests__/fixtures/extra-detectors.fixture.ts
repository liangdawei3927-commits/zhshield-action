// fixture: extra-detectors semantic exemption tests
// 反例类（新语义失效时应被报告）集中在 eff 后缀类，正例类（豁免）为其余类
// 注意: fixture 仅被 parseFile 解析(tsconfig 排除 __tests__)，基类无需真实存在，AST 解析不受影响

// === switch-statement: 纯分发表 (每 case 以 return/throw 终止) ===
export class PureDispatchService {
  resolve(kind: 'a' | 'b' | 'c'): string {
    switch (kind) {
      case 'a':
        return 'a-result';
      case 'b':
        return this.buildB();
      case 'c':
        throw new Error('c not supported');
    }
  }

  private buildB(): string {
    return 'b';
  }
}

// === switch-statement: 非纯分发 switch (有 break + 共享状态) ===
export class ImperativeSwitchService {
  apply(mode: string): string {
    let result = '';
    switch (mode) {
      case 'fast':
        result = 'f';
        break;
      case 'slow':
        result = 's';
        break;
      default:
        result = '?';
    }
    return result;
  }
}

// === message-chains: 字符串字面量里的点 (i18n 键) 不是链 ===
export class I18nRenderer {
  render(): string {
    return tr('engine.inspect.tool.tsc.runFailed');
  }
}

// === message-chains: 真实长链 (引号外) 仍应报告 ===
export class ChainClient {
  fetch(): string {
    const endpoint = this.getConfig();
    return endpoint.policy.rule.engine.id;
  }

  private getConfig(): Record<string, unknown> {
    return {};
  }
}

// === refused-bequest: extends Error (语言惯例, 错误类天然无新成员) ===
export class ToolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolUnavailableError';
  }
}

// === refused-bequest: extends *Adapter (适配器/模板方法契约) ===
export class SecurityScanAdapter extends ScanAdapter<string> {
  transform(raw: string): string {
    return raw.trim();
  }
}

// === refused-bequest: extends Component (React 生命周期契约) ===
export class ErrorBoundary extends Component<Record<string, unknown>, Record<string, unknown>> {
  render(): string {
    return 'error-boundary';
  }
}

// === refused-bequest: 子类引用继承成员 (使用 super / this.<基类成员>) ===
export class VerifiedClient extends BaseClient {
  refresh(): void {
    super.buildHeaders();
    this.compressor.run();
  }
}

// === refused-bequest 反例: 空子类且不使用继承成员, 应仍被报告 ===
export class EmptyLazySubclass extends BaseService {}

// === lazy-class 豁免: implements 接口的契约载体 (DI 第二实现 / 测试替身) ===
/** 契约载体接口（lazy-class 豁免用例：implements 接口不视为 lazy-class） */
export interface SecretStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();

  read(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.map.set(key, value);
  }
}
