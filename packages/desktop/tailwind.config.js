/** @type {import('tailwindcss').Config} */

/** 三主题 token 注册表：颜色一律引用 CSS 变量 RGB 三元组 (rgb(var(--zh-x) / <alpha-value>))，
 *  由 src/index.css 的 :root / [data-theme="legacy"] / [data-theme="dracula"] 驱动换肤。
 *  色值溯源 VI 规范 07-品牌视觉规范.md §6 暗色模式 / §7 报告 Token；emerald 与 green 完全一致（成功绿家族）。 */
const successScale = {
  50: 'rgb(var(--zh-success-50) / <alpha-value>)',
  100: 'rgb(var(--zh-success-100) / <alpha-value>)',
  200: 'rgb(var(--zh-success-200) / <alpha-value>)',
  300: 'rgb(var(--zh-success-300) / <alpha-value>)',
  400: 'rgb(var(--zh-success-400) / <alpha-value>)',
  500: 'rgb(var(--zh-success-500) / <alpha-value>)',
  600: 'rgb(var(--zh-success-600) / <alpha-value>)',
  700: 'rgb(var(--zh-success-700) / <alpha-value>)',
  800: 'rgb(var(--zh-success-800) / <alpha-value>)',
  900: 'rgb(var(--zh-success-900) / <alpha-value>)',
  DEFAULT: 'rgb(var(--zh-success) / <alpha-value>)',
  dark: 'rgb(var(--zh-success-700) / <alpha-value>)',
};

const infoScale = {
  50: 'rgb(var(--zh-info-50) / <alpha-value>)',
  100: 'rgb(var(--zh-info-100) / <alpha-value>)',
  200: 'rgb(var(--zh-info-200) / <alpha-value>)',
  300: 'rgb(var(--zh-info-300) / <alpha-value>)',
  400: 'rgb(var(--zh-info-400) / <alpha-value>)',
  500: 'rgb(var(--zh-info-500) / <alpha-value>)',
  600: 'rgb(var(--zh-info-600) / <alpha-value>)',
  700: 'rgb(var(--zh-info-700) / <alpha-value>)',
  800: 'rgb(var(--zh-info-800) / <alpha-value>)',
  900: 'rgb(var(--zh-info-900) / <alpha-value>)',
  DEFAULT: 'rgb(var(--zh-info) / <alpha-value>)',
  dark: 'rgb(var(--zh-info-700) / <alpha-value>)',
};

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'rgb(var(--zh-brand-50) / <alpha-value>)',
          100: 'rgb(var(--zh-brand-100) / <alpha-value>)',
          200: 'rgb(var(--zh-brand-200) / <alpha-value>)',
          300: 'rgb(var(--zh-brand-300) / <alpha-value>)',
          400: 'rgb(var(--zh-brand-400) / <alpha-value>)',
          500: 'rgb(var(--zh-brand-500) / <alpha-value>)',
          600: 'rgb(var(--zh-brand-600) / <alpha-value>)',
          700: 'rgb(var(--zh-brand-700) / <alpha-value>)',
          800: 'rgb(var(--zh-brand-800) / <alpha-value>)',
          900: 'rgb(var(--zh-brand-900) / <alpha-value>)',
          DEFAULT: 'rgb(var(--zh-brand) / <alpha-value>)',
          dark: 'rgb(var(--zh-brand-dark) / <alpha-value>)',
          light: 'rgb(var(--zh-brand-light) / <alpha-value>)',
          lighter: 'rgb(var(--zh-brand-lighter) / <alpha-value>)',
          green: 'rgb(var(--zh-success) / <alpha-value>)',
          blue: 'rgb(var(--zh-info) / <alpha-value>)',
          orange: 'rgb(var(--zh-warning) / <alpha-value>)',
          red: 'rgb(var(--zh-danger) / <alpha-value>)',
        },
        /* 覆盖 Tailwind 默认色板 → VI 规范家族（成功绿 / AI 智靛），emerald 同 green */
        green: successScale,
        emerald: successScale,
        blue: infoScale,
        /* 语义别名: 组件换肤类 (Agent B 使用) */
        zh: {
          bg: 'rgb(var(--zh-bg-primary) / <alpha-value>)',
          card: 'rgb(var(--zh-bg-tertiary) / <alpha-value>)',
          panel: 'rgb(var(--zh-bg-secondary) / <alpha-value>)',
          ink: 'rgb(var(--zh-ink) / <alpha-value>)',
          'ink-2': 'rgb(var(--zh-ink-2) / <alpha-value>)',
          muted: 'rgb(var(--zh-muted) / <alpha-value>)',
          line: 'rgb(var(--zh-line) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
