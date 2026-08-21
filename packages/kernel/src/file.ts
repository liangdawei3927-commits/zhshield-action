import * as fs from 'fs';
import * as path from 'path';

export class FileHelper {
  static async readJSON(filePath: string): Promise<unknown> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  static async writeJSON(filePath: string, data: unknown, indent: number = 2): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, indent), 'utf-8');
  }

  static async ensureDir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  static async copy(src: string, dest: string): Promise<void> {
    await this.ensureDir(path.dirname(dest));
    await fs.promises.copyFile(src, dest);
  }

  static async glob(pattern: string, dir: string): Promise<string[]> {
    const results: string[] = [];
    const dirEntries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.glob(pattern, fullPath);
        results.push(...sub);
      } else if (entry.name.includes(pattern.replace('*', ''))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  static async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
