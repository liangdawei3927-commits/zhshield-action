// FormDetector 单测：只采集形态特征文件存在性原始信号（语义判定在 Profiler，此处不做）。

import { describe, expect, it } from 'vitest';
import { FormDetector } from '../detectors/form-detector';
import { makeTempProject, cleanupTempProject } from './helpers';

const detector = new FormDetector();

function ruleIds(signals: { ruleId: string }[]): string[] {
  return signals.map((s) => s.ruleId);
}

describe('FormDetector', () => {
  it('GIVEN package.json 含 electron WHEN detect THEN 产出 form:electron 原始信号', async () => {
    const root = makeTempProject({
      'package.json': JSON.stringify({ name: 'desk', dependencies: { electron: '^30.0.0' } }),
    });
    try {
      const signals = await detector.detect(root);
      expect(ruleIds(signals)).toContain('form:electron');
      expect(signals.every((s) => s.kind === 'form')).toBe(true);
      expect(signals.every((s) => s.weight === 0.5)).toBe(true);
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN ios/ 下 Podfile 与 *.xcodeproj WHEN detect THEN 产出 form:podfile + form:xcodeproj', async () => {
    const root = makeTempProject({
      'ios/Podfile': "platform :ios, '15.0'\ntarget 'App' do\nend\n",
      'ios/App.xcodeproj/project.pbxproj': '// pbxproj placeholder\n',
    });
    try {
      const signals = await detector.detect(root);
      expect(ruleIds(signals)).toEqual(expect.arrayContaining(['form:podfile', 'form:xcodeproj']));
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN android/ 下 build.gradle 与 AndroidManifest.xml WHEN detect THEN 产出 android 形态信号', async () => {
    const root = makeTempProject({
      'android/build.gradle': "plugins { id 'com.android.application' }\n",
      'android/app/src/main/AndroidManifest.xml': '<manifest xmlns:android="..."></manifest>\n',
    });
    try {
      const signals = await detector.detect(root);
      expect(ruleIds(signals)).toEqual(
        expect.arrayContaining(['form:android-gradle', 'form:android-manifest']),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN miniapp/ 下 project.config.json WHEN detect THEN 产出 form:miniapp-project-config', async () => {
    const root = makeTempProject({
      'miniapp/project.config.json': '{ "appid": "touristappid", "compileType": "miniprogram" }',
    });
    try {
      const signals = await detector.detect(root);
      expect(ruleIds(signals)).toContain('form:miniapp-project-config');
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN index.html 与 vite.config.ts WHEN detect THEN 产出 h5 形态信号（index-html + web-bundler）', async () => {
    const root = makeTempProject({
      'index.html': '<!doctype html><html><body></body></html>\n',
      'vite.config.ts': 'export default {}',
    });
    try {
      const signals = await detector.detect(root);
      expect(ruleIds(signals)).toEqual(
        expect.arrayContaining(['form:index-html', 'form:web-bundler']),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 服务端框架依赖 + db 配置 + api/ 目录 WHEN detect THEN 产出 backend 形态信号集', async () => {
    const root = makeTempProject({
      'pyproject.toml': '[project]\ndependencies = ["fastapi==0.111.0"]\n',
      '.env': 'DATABASE_URL=postgres://localhost/app\n',
      'api/routes.py': 'from fastapi import APIRouter\n',
    });
    try {
      const signals = await detector.detect(root);
      expect(ruleIds(signals)).toEqual(
        expect.arrayContaining(['form:server-framework', 'form:db-config', 'form:dir-api']),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 无形态特征的空目录 WHEN detect THEN 不产出任何信号', async () => {
    const root = makeTempProject({});
    try {
      const signals = await detector.detect(root);
      expect(signals).toEqual([]);
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 深层嵌套形态文件（apps/native/ios/Podfile 与 packages/app/App.xcodeproj，≥3 层路径）WHEN detect THEN 深层信号与 bundle 均被发现', async () => {
    const root = makeTempProject({
      'apps/native/ios/Podfile': "platform :ios, '15.0'\ntarget 'App' do\nend\n",
      'packages/app/App.xcodeproj/project.pbxproj': '// pbxproj placeholder\n',
    });
    try {
      const signals = await detector.detect(root);

      const podfile = signals.find((s) => s.ruleId === 'form:podfile');
      expect(podfile?.file).toBe('apps/native/ios/Podfile');

      const bundle = signals.find((s) => s.ruleId === 'form:xcodeproj');
      expect(bundle?.file).toBe('packages/app/App.xcodeproj');
    } finally {
      cleanupTempProject(root);
    }
  });
});
