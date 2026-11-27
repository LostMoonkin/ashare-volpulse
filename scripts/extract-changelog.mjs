import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VERSION_HEADING_PATTERN = /^##\s+\[?v?([^\s\]]+)\]?(?:\s+.*)?$/i;
const REFERENCE_LINK_DEF_PATTERN = /^\[[^\]]+\]:\s+\S+/;
const MARKDOWN_LINK_PATTERN = /(!?\[[^\]]*\]\()([^)\s]+)(\))/g;

/**
 * 规范化 Tag 或版本号，去除前导 v/V 与首尾空白。
 * 例如：`v0.1.6` -> `0.1.6`。
 */
export function normalizeVersion(raw) {
  if (!raw) return '';
  return String(raw).trim().replace(/^v/i, '');
}

/**
 * 将相对路径的 Markdown 链接重写为 GitHub 仓库对应 Tag 的绝对链接，
 * 避免在 GitHub Release 页面中点击文档链接出现 404。
 */
export function rewriteRelativeLinks(markdown, options = {}) {
  const repo = options.repo ? String(options.repo).trim() : '';
  const ref = options.ref ? String(options.ref).trim() : '';
  if (!markdown || !repo || !ref) {
    return markdown;
  }

  return markdown.replace(MARKDOWN_LINK_PATTERN, (fullMatch, prefix, target, suffix) => {
    if (
      /^(?:https?:\/\/|mailto:|#|\/)/i.test(target) ||
      target.startsWith('data:')
    ) {
      return fullMatch;
    }
    const cleanPath = target.replace(/^\.\//, '');
    return `${prefix}https://github.com/${repo}/blob/${ref}/${cleanPath}${suffix}`;
  });
}

/**
 * 从 Keep a Changelog 格式的 Markdown 中提取指定版本对应的章节正文。
 * 未命中或章节为空时返回 null。
 */
export function extractChangelogSection(markdown, rawTagOrVersion, options = {}) {
  const targetVersion = normalizeVersion(rawTagOrVersion);
  if (!markdown || !targetVersion) {
    return null;
  }

  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  let startIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const match = VERSION_HEADING_PATTERN.exec(lines[i].trim());
    if (match && normalizeVersion(match[1]) === targetVersion) {
      startIndex = i + 1;
      break;
    }
  }

  if (startIndex === -1) {
    return null;
  }

  const collected = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed) || REFERENCE_LINK_DEF_PATTERN.test(trimmed)) {
      break;
    }
    collected.push(line);
  }

  const body = collected.join('\n').trim();
  if (!body) {
    return null;
  }

  return rewriteRelativeLinks(body, {
    repo: options.repo,
    ref: options.ref ?? (rawTagOrVersion ? String(rawTagOrVersion).trim() : ''),
  });
}

function parseArgs(argv) {
  const args = {
    tag: process.env.GITHUB_REF_NAME ?? '',
    changelog: 'CHANGELOG.md',
    output: '',
    repo: process.env.GITHUB_REPOSITORY ?? '',
    strict: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--tag' || arg === '--version') && argv[i + 1]) {
      args.tag = argv[++i];
    } else if (arg === '--changelog' && argv[i + 1]) {
      args.changelog = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      args.output = argv[++i];
    } else if (arg === '--repo' && argv[i + 1]) {
      args.repo = argv[++i];
    } else if (arg === '--strict') {
      args.strict = true;
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const changelogPath = resolve(ROOT_DIR, args.changelog);
  const rawMarkdown = readFileSync(changelogPath, 'utf8');
  const section = extractChangelogSection(rawMarkdown, args.tag, {
    repo: args.repo,
    ref: args.tag,
  });

  if (!section) {
    const message = `[extract-changelog] 未在 ${args.changelog} 中找到版本 ${args.tag || '(空)'} 对应的变更记录。`;
    if (args.strict) {
      console.error(message);
      process.exit(1);
    }
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::warning::${message}`);
    } else {
      console.warn(message);
    }
  }

  const content = section ? `${section}\n` : '';
  if (args.output) {
    writeFileSync(resolve(ROOT_DIR, args.output), content, 'utf8');
  } else if (content) {
    process.stdout.write(content);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
