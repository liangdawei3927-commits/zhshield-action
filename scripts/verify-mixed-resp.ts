/**
 * 临时复验脚本：仅运行 mixed-responsibilities 检测器扫描指定文件。
 * 用法: tsx scripts/verify-mixed-resp.ts <file1> <file2> ...
 */
import { RefactorEngine } from '../packages/refactor/src/engine';

const PROJECT_ROOT = '/Users/dawei/Desktop/ZHCodeShieid/zhiyan-codeshield';

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: tsx scripts/verify-mixed-resp.ts <file1> <file2> ...');
    process.exit(1);
  }
  const engine = new RefactorEngine({ enabledRules: ['mixed-responsibilities'] });
  const report = await engine.analyzeFiles(PROJECT_ROOT, files);
  let total = 0;
  for (const f of report.files) {
    for (const s of f.smells) {
      total += 1;
      console.log(`${s.location.filePath}:${s.location.line} ${s.message}`);
    }
  }
  console.log(`TOTAL_REMAINING=${total}`);
  process.exit(total > 0 ? 1 : 0);
}

void main();
