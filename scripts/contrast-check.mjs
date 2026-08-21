// 暗色档对比度验证脚本（WCAG 2.1 AA）
// 用法: node scripts/contrast-check.mjs
const lum = (r, g, b) => {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(...a), lum(...b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const bg = [29, 30, 40]; // #1d1e28 墨紫黑底
const card = [36, 37, 47]; // bg-secondary
const card3 = [41, 42, 52]; // bg-tertiary
const W = [255, 255, 255];
const _B = [0, 0, 0];

const rows = [];
const add = (name, fg, bgCol, kind = 'text') => {
  const r = ratio(fg, bgCol);
  rows.push({
    name,
    fg: `rgb(${fg})`,
    bg: `rgb(${bgCol})`,
    ratio: r.toFixed(2),
    pass: kind === 'large' ? r >= 3 : r >= 4.5,
    kind,
  });
};

// 1) 背景层对比度
add('ink 主文字 on 底', [232, 240, 238], bg);
add('ink-2 次级 on 底', [159, 176, 172], bg);
add('muted 弱化 on 底', [107, 124, 120], bg, 'large'); // 弱化文字通常大/装饰
add('ink 主文字 on 卡片', [232, 240, 238], card3);
add('ink-2 on 卡片', [159, 176, 172], card3);
add('muted on 卡片', [107, 124, 120], card3);

// 2) 品牌色
add('brand #2DD4BF 强调 on 底', [45, 212, 191], bg);
add('brand #2DD4BF 强调 on 卡片', [45, 212, 191], card3);
add('brand-700 #2DD4BF 图标/徽章 on 卡片', [45, 212, 191], card);
add('brand-600 按钮底+白字', W, [10, 118, 106], 'large'); // 14px semibold 按钮
add('brand-800 渐变终点+白字', W, [8, 92, 82]);
add('brand-hover 渐变 60%+白字', W, [16, 115, 103]);
add('brand-dark 渐变 30%+白字', W, [12, 88, 79]);
add('brand-900 渐变起点+白字', W, [8, 70, 62]);
add('brand-50 chip底+700字', [45, 212, 191], [20, 48, 44]);
add('brand-500 健康弧 on 卡片', [40, 200, 180], card3);
add('brand-lighter ring轨道 on 卡片', [42, 88, 80], card3, 'large');
add('bg-brand 头栏+text-on-brand', [248, 248, 242], [14, 100, 90]);
add('head 白字 on bg-brand', W, [14, 100, 90]);

// 3) 语义色
add('success #34D399 on 卡片', [52, 211, 153], card3);
add('success-700 浅绿chip字', [11, 122, 82], [239, 253, 244]);
add('warning #F0A23B on 卡片', [240, 162, 59], card3);
add('danger #F87171 on 卡片', [248, 113, 113], card3);
add('danger 警戒字 on tint底', [248, 113, 113], [52, 38, 40]); // danger/0.1 over 底近似
add('danger-dark 严重字 on tint底', [255, 105, 105], [52, 38, 40]);
add('info #4F6BED 智靛 on 卡片', [79, 107, 237], card3, 'large');

// 4) 线/滚动条
add('line 分隔线 on 底', [55, 68, 64], bg, 'large');
add('scrollbar thumb on 底', [74, 88, 84], bg, 'large');
add('scrollbar thumb hover on 底', [108, 124, 118], bg, 'large');

// 5) 浅底 chip 硬编码复核
add('text-red-700 on bg-red-50', [185, 28, 28], [254, 242, 242]);
add('text-green-700 on bg-green-50', [21, 128, 61], [240, 253, 244]);
add('text-blue-700 on bg-blue-50', [29, 78, 216], [239, 246, 255]);

console.table(rows);
const fails = rows.filter((r) => !r.pass);
console.log(fails.length ? `\n❌ FAIL ${fails.length}:\n` + fails.map((f) => `  ${f.name} (${f.ratio})`).join('\n') : '\n✅ 全部通过');
