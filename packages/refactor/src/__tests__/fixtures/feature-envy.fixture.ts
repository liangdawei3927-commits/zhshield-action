import * as path from 'node:path';
import * as fs from 'node:fs';

export class Payload {
  private readonly items: string[] = [];

  add(value: string): void {
    this.items.push(value);
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }

  clone(): Payload {
    return new Payload();
  }

  serialize(): string {
    return this.items.join(',');
  }
}

export class EnviousFormatter {
  render(payload: Payload): string {
    const count = payload.size();
    if (count === 0) {
      payload.clear();
    }
    payload.clone();
    payload.add('x');
    payload.add('y');
    return payload.serialize();
  }
}

export class LineAccumulator {
  format(value: string, lines: string[]): void {
    lines.push('');
    lines.push(value);
    lines.push(value);
    lines.push(value);
    lines.push(value);
    lines.push('');
  }
}

export class PathProbe {
  resolveTarget(projectPath: string): string {
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) return srcDir;
    const packagesDir = path.join(projectPath, 'packages');
    if (fs.existsSync(packagesDir)) return packagesDir;
    return path.resolve(projectPath);
  }
}

export class FlagBuilder {
  build(flags: string[]): string {
    const merged = [...flags];
    merged.push('--noEmit');
    if (!merged.includes('--composite')) merged.push('--composite', 'false');
    const encoded = JSON.stringify(merged);
    return Buffer.from(encoded, 'utf-8').toString('utf-8');
  }
}
