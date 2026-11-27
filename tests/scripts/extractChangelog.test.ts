import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractChangelogSection,
  normalizeVersion,
  rewriteRelativeLinks,
} from '../../scripts/extract-changelog.mjs';

const SAMPLE_CHANGELOG = `# Changelog

本文件记录主要变更历史。

## [0.1.6] - 2026-11-26

### Fixed
- 修复 Windows 托盘图标构建问题。

## [0.1.5] - 2026-11-26

### Added
- 标准模式支持自由缩放。

### Docs & Specs
- 新增规范 [\`docs/specs/hud-resizable-standard-mode.md\`](docs/specs/hud-resizable-standard-mode.md)，以及 [外链](https://example.com/doc) 与 [锚点](#top)。

## [0.1.5-beta.1] - 2026-11-25

### Added
- 预览版特性。

## [0.1.0] - 2026-11-25

### Added
- 首个完整版本发布。

[0.1.6]: https://github.com/owner/repo/releases/tag/v0.1.6
[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0
`;

describe('extract-changelog', () => {
  it('规范化带 v/V 前缀与空白的版本号', () => {
    expect(normalizeVersion('v0.1.6')).toBe('0.1.6');
    expect(normalizeVersion('V0.1.6 ')).toBe('0.1.6');
    expect(normalizeVersion('0.2.0-rc.1')).toBe('0.2.0-rc.1');
    expect(normalizeVersion('')).toBe('');
  });

  it('按 Tag 精确提取指定版本章节且不串入相邻版本', () => {
    const section = extractChangelogSection(SAMPLE_CHANGELOG, 'v0.1.6');
    expect(section).toBe('### Fixed\n- 修复 Windows 托盘图标构建问题。');
  });

  it('区分正式版与预发布版，避免前缀误匹配', () => {
    const stable = extractChangelogSection(SAMPLE_CHANGELOG, 'v0.1.5');
    expect(stable).toContain('标准模式支持自由缩放');
    expect(stable).not.toContain('预览版特性');

    const beta = extractChangelogSection(SAMPLE_CHANGELOG, 'v0.1.5-beta.1');
    expect(beta).toBe('### Added\n- 预览版特性。');
  });

  it('在文档末尾的参考链接定义处正确截断', () => {
    const first = extractChangelogSection(SAMPLE_CHANGELOG, 'v0.1.0');
    expect(first).toBe('### Added\n- 首个完整版本发布。');
  });

  it('兼容 Windows CRLF 换行与无方括号标题', () => {
    const crlf = '## v0.2.0 - 2026-12-01\r\n\r\n### Changed\r\n- 调整样式。\r\n\r\n## 0.1.9\r\n- 旧版本。\r\n';
    expect(extractChangelogSection(crlf, 'v0.2.0')).toBe('### Changed\n- 调整样式。');
    expect(extractChangelogSection(crlf, 'v0.1.9')).toBe('- 旧版本。');
  });

  it('指定 repo 与 ref 时将相对文档链接转换为 GitHub blob 绝对链接，保留外链与锚点', () => {
    const section = extractChangelogSection(SAMPLE_CHANGELOG, 'v0.1.5', {
      repo: 'owner/ashare-volpulse',
      ref: 'v0.1.5',
    });
    expect(section).toContain(
      '[`docs/specs/hud-resizable-standard-mode.md`](https://github.com/owner/ashare-volpulse/blob/v0.1.5/docs/specs/hud-resizable-standard-mode.md)',
    );
    expect(section).toContain('[外链](https://example.com/doc)');
    expect(section).toContain('[锚点](#top)');
  });

  it('rewriteRelativeLinks 去掉 ./ 前缀并保持无 repo 参数时原样输出', () => {
    expect(rewriteRelativeLinks('[文档](./docs/PLAN.md)', { repo: 'a/b', ref: 'v1.0.0' })).toBe(
      '[文档](https://github.com/a/b/blob/v1.0.0/docs/PLAN.md)',
    );
    expect(rewriteRelativeLinks('[文档](./docs/PLAN.md)')).toBe('[文档](./docs/PLAN.md)');
  });

  it('版本不存在或章节为空时返回 null', () => {
    expect(extractChangelogSection(SAMPLE_CHANGELOG, 'v9.9.9')).toBeNull();
    expect(extractChangelogSection('## [0.2.0] - 2026-12-01\n\n## [0.1.0]\n- init', 'v0.2.0')).toBeNull();
  });

  it('能够从仓库真实 CHANGELOG.md 经 CLI 提取最新已发布版本并写入输出文件', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'extract-changelog-'));
    const outputFile = join(tempDir, 'release-notes.md');
    const scriptPath = resolve('scripts/extract-changelog.mjs');

    try {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--tag',
          'v0.1.6',
          '--changelog',
          'CHANGELOG.md',
          '--output',
          outputFile,
          '--repo',
          'owner/ashare-volpulse',
        ],
        { encoding: 'utf8' },
      );

      const output = readFileSync(outputFile, 'utf8');
      expect(output).toContain('### Fixed');
      expect(output).toContain('加固系统托盘图标构建');
      expect(output).not.toContain('## [0.1.5]');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('未命中版本时默认写出空文件（供 GitHub Release 回退自动生成说明）', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'extract-changelog-miss-'));
    const outputFile = join(tempDir, 'release-notes.md');
    const scriptPath = resolve('scripts/extract-changelog.mjs');

    try {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--tag',
          'v9.9.9',
          '--changelog',
          'CHANGELOG.md',
          '--output',
          outputFile,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

      expect(readFileSync(outputFile, 'utf8')).toBe('');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
