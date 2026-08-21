const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'sop');
const distDir = path.join(__dirname, '..', 'dist', 'sop');
const assetsSrcDir = path.join(__dirname, '..', 'assets');
const assetsDistDir = path.join(__dirname, '..', 'dist', 'assets');

const YAML_EXT = /\.ya?ml$/i;

/** 递归拷贝目录下所有文件（SOP 规则只保留 YAML；assets 全部保留） */
function copyFiles(dir, rootDir, distRoot, onlyYaml) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, srcPath);
    const destPath = path.join(distRoot, relPath);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyFiles(srcPath, rootDir, distRoot, onlyYaml);
    } else if (entry.isFile() && (!onlyYaml || YAML_EXT.test(entry.name))) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      console.log(`  [copy] ${relPath}`);
    }
  }
}

console.log('Copying SOP YAML rules to dist...');
copyFiles(srcDir, srcDir, distDir, true);
console.log('Copying assets to dist...');
copyFiles(assetsSrcDir, assetsSrcDir, assetsDistDir, false);
console.log('Done.');
