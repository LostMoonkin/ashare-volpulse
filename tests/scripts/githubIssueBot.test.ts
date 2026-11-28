import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addIssueLabels,
  createAppJwt,
  exchangeInstallationToken,
  fetchAppIdentity,
  filterRealIssues,
  getIssueDetail,
  listIssues,
  needsBotReply,
  parseCliArgs,
  parseRepoSlug,
  postIssueComment,
  removeIssueLabel,
  resolveConfig,
  sanitizeErrorMessage,
} from '../../scripts/github-issue-bot.mjs';

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return JSON.parse(Buffer.from(padded + padding, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function createMockResponse(status: number, body: unknown): Response {
  const textBody = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => textBody,
  } as unknown as Response;
}

describe('github-issue-bot', () => {
  it('使用测试密钥对生成符合 GitHub App 规范且可验签的 RS256 JWT', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });

    const now = 1_700_000_000;
    const jwt = createAppJwt('5963710', privateKey, now);
    const segments = jwt.split('.');
    expect(segments).toHaveLength(3);

    const header = decodeBase64UrlJson(segments[0]);
    const payload = decodeBase64UrlJson(segments[1]);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toEqual({
      iat: now - 60,
      exp: now + 540,
      iss: '5963710',
    });

    const signingInput = `${segments[0]}.${segments[1]}`;
    const signature = Buffer.from(
      segments[2].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    const verified = verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), publicKey, signature);
    expect(verified).toBe(true);

    expect(() => createAppJwt('', privateKey, now)).toThrow(/App ID/);
    expect(() => createAppJwt('5963710', '', now)).toThrow(/私钥/);
  });

  it('parseRepoSlug 兼容 owner/repo 与 GitHub URL，并拒绝非法格式', () => {
    expect(parseRepoSlug('LostMoonkin/ashare-volpulse')).toEqual({
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
    });
    expect(parseRepoSlug('https://github.com/LostMoonkin/ashare-volpulse')).toEqual({
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
    });
    expect(parseRepoSlug('https://github.com/LostMoonkin/ashare-volpulse.git/')).toEqual({
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
    });

    expect(() => parseRepoSlug('')).toThrow();
    expect(() => parseRepoSlug('ashare-volpulse')).toThrow();
    expect(() => parseRepoSlug('LostMoonkin/ashare-volpulse/issues')).toThrow();
  });

  it('resolveConfig 支持加载本地文件、环境变量覆盖、占位符校验与路径解析', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gh-issue-bot-cfg-'));
    try {
      const localConfigPath = join(tempDir, '.github-issue-bot.local.json');
      writeFileSync(
        localConfigPath,
        JSON.stringify({
          owner: 'LostMoonkin',
          repo: 'ashare-volpulse',
          appId: '1001',
          installationId: '2002',
          privateKeyPath: 'C:\\Users\\tester\\.config\\gh-boot\\bot.pem',
        }),
        'utf8',
      );

      const loaded = resolveConfig({ rootDir: tempDir, env: {} });
      expect(loaded).toEqual({
        configPath: localConfigPath,
        owner: 'LostMoonkin',
        repo: 'ashare-volpulse',
        appId: '1001',
        installationId: '2002',
        privateKeyPath: 'C:\\Users\\tester\\.config\\gh-boot\\bot.pem',
      });

      const overridden = resolveConfig({
        rootDir: tempDir,
        env: {
          GH_ISSUE_BOT_REPO: 'https://github.com/OtherOwner/other-repo.git',
          GH_ISSUE_BOT_APP_ID: '9999',
          GH_ISSUE_BOT_PRIVATE_KEY_PATH: '~/.config/gh-boot/override.pem',
        },
      });
      expect(overridden.owner).toBe('OtherOwner');
      expect(overridden.repo).toBe('other-repo');
      expect(overridden.appId).toBe('9999');
      expect(overridden.privateKeyPath).toBe(join(homedir(), '.config', 'gh-boot', 'override.pem'));

      const relativeCfgPath = join(tempDir, 'relative.json');
      writeFileSync(
        relativeCfgPath,
        JSON.stringify({
          owner: 'LostMoonkin',
          repo: 'ashare-volpulse',
          appId: '1001',
          installationId: '2002',
          privateKeyPath: './keys/app.pem',
        }),
        'utf8',
      );
      const relLoaded = resolveConfig({
        rootDir: tempDir,
        configPath: relativeCfgPath,
        env: {},
      });
      expect(relLoaded.privateKeyPath).toBe(resolve(tempDir, 'keys', 'app.pem'));

      const placeholderCfgPath = join(tempDir, 'placeholder.json');
      writeFileSync(
        placeholderCfgPath,
        JSON.stringify({
          owner: 'LostMoonkin',
          repo: 'ashare-volpulse',
          appId: '<YOUR_GITHUB_APP_ID>',
          installationId: '2002',
          privateKeyPath: './keys/app.pem',
        }),
        'utf8',
      );
      expect(() =>
        resolveConfig({ rootDir: tempDir, configPath: placeholderCfgPath, env: {} }),
      ).toThrow(/占位符/);

      const emptyDir = mkdtempSync(join(tmpdir(), 'gh-issue-bot-empty-'));
      try {
        expect(() => resolveConfig({ rootDir: emptyDir, env: {} })).toThrow(
          /\.github-issue-bot\.example\.json/,
        );
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filterRealIssues 自动剔除 Pull Request，needsBotReply 准确判断回复状态', () => {
    const rawItems = [
      { number: 1, title: '真实 Issue' },
      { number: 2, title: '混入的 PR', pull_request: { url: 'https://api.github.com/...' } },
      { number: 3, title: '另一条 Issue' },
    ];
    expect(filterRealIssues(rawItems).map((item) => item.number)).toEqual([1, 3]);

    expect(needsBotReply({}, [], 'ashare-volpulse-bot[bot]', 'LostMoonkin')).toBe(true);
    expect(
      needsBotReply(
        {},
        [{ user: { login: 'AShare-Volpulse-Bot[bot]' } }],
        'ashare-volpulse-bot[bot]',
        'LostMoonkin',
      ),
    ).toBe(false);
    expect(
      needsBotReply(
        {},
        [{ user: { login: 'lostmoonkin' } }],
        'ashare-volpulse-bot[bot]',
        'LostMoonkin',
      ),
    ).toBe(false);
    expect(
      needsBotReply(
        {},
        [
          { user: { login: 'ashare-volpulse-bot[bot]' } },
          { user: { login: 'external-user' } },
        ],
        'ashare-volpulse-bot[bot]',
        'LostMoonkin',
      ),
    ).toBe(true);
  });

  it('通过 Mock fetch 覆盖鉴权、列表、详情、评论、标签与敏感信息脱敏', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const recordedCalls: Array<{ url: string; method: string; auth: string; body?: string }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      recordedCalls.push({
        url,
        method,
        auth: headers.Authorization ?? '',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      if (pathname.endsWith('/app')) {
        return createMockResponse(200, {
          id: 5963710,
          slug: 'ashare-volpulse-bot',
          name: 'ashare-volpulse-bot',
          html_url: 'https://github.com/apps/ashare-volpulse-bot',
        });
      }
      if (pathname.endsWith('/app/installations/186750238/access_tokens')) {
        return createMockResponse(201, {
          token: 'ghs_secret_install_token_123456',
          expires_at: '2026-11-28T17:30:00Z',
          permissions: { issues: 'write', metadata: 'read' },
          repository_selection: 'selected',
        });
      }
      if (pathname.endsWith('/issues') && method === 'GET') {
        return createMockResponse(200, [
          {
            number: 10,
            title: 'PR 应该被过滤',
            state: 'open',
            pull_request: {},
          },
          {
            number: 11,
            title: '盘中斜率展示建议',
            state: 'open',
            user: { login: 'alice' },
            labels: [{ name: 'enhancement' }],
            comments: 0,
            created_at: '2026-11-28T08:00:00Z',
            updated_at: '2026-11-28T08:10:00Z',
            html_url: 'https://github.com/LostMoonkin/ashare-volpulse/issues/11',
          },
        ]);
      }
      if (pathname.endsWith('/issues/99')) {
        return createMockResponse(200, {
          number: 99,
          title: '这是一个 PR',
          pull_request: { url: 'https://api.github.com/repos/a/b/pulls/99' },
        });
      }
      if (pathname.endsWith('/issues/99/comments')) {
        return createMockResponse(200, []);
      }
      if (pathname.endsWith('/issues/11')) {
        return createMockResponse(200, {
          number: 11,
          title: '盘中斜率展示建议',
          state: 'open',
          user: { login: 'alice' },
          labels: [{ name: 'enhancement' }],
          comments: 1,
          body: '正文内容',
          created_at: '2026-11-28T08:00:00Z',
          updated_at: '2026-11-28T08:10:00Z',
          html_url: 'https://github.com/LostMoonkin/ashare-volpulse/issues/11',
        });
      }
      if (pathname.endsWith('/issues/11/comments') && method === 'GET') {
        return createMockResponse(200, [
          {
            id: 501,
            user: { login: 'alice' },
            author_association: 'NONE',
            body: '补充说明',
            created_at: '2026-11-28T08:10:00Z',
            updated_at: '2026-11-28T08:10:00Z',
            html_url: 'https://github.com/LostMoonkin/ashare-volpulse/issues/11#issuecomment-501',
          },
        ]);
      }
      if (pathname.endsWith('/issues/11/comments') && method === 'POST') {
        return createMockResponse(201, {
          id: 502,
          user: { login: 'ashare-volpulse-bot[bot]' },
          created_at: '2026-11-28T08:20:00Z',
          html_url: 'https://github.com/LostMoonkin/ashare-volpulse/issues/11#issuecomment-502',
        });
      }
      if (pathname.endsWith('/issues/11/labels') && method === 'POST') {
        return createMockResponse(200, [{ name: 'enhancement' }, { name: 'triage' }]);
      }
      if (pathname.endsWith('/issues/11/labels/triage') && method === 'DELETE') {
        return createMockResponse(200, [{ name: 'enhancement' }]);
      }
      return createMockResponse(404, { message: 'Not Found' });
    };

    const identity = await fetchAppIdentity({
      appId: '5963710',
      privateKeyPem: privateKey,
      fetchImpl: mockFetch,
    });
    expect(identity.botLogin).toBe('ashare-volpulse-bot[bot]');

    const tokenRes = await exchangeInstallationToken({
      appId: '5963710',
      installationId: '186750238',
      privateKeyPem: privateKey,
      fetchImpl: mockFetch,
    });
    expect(tokenRes.token).toBe('ghs_secret_install_token_123456');
    expect(tokenRes.permissions).toEqual({ issues: 'write', metadata: 'read' });

    const issues = await listIssues({
      token: tokenRes.token,
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
      label: 'enhancement',
      fetchImpl: mockFetch,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(11);
    expect(recordedCalls.find((c) => c.url.includes('/issues?'))?.url).toContain(
      'labels=enhancement',
    );

    const detail = await getIssueDetail({
      token: tokenRes.token,
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
      issueNumber: 11,
      fetchImpl: mockFetch,
    });
    expect(detail.body).toBe('正文内容');
    expect(detail.comments).toHaveLength(1);

    await expect(
      getIssueDetail({
        token: tokenRes.token,
        owner: 'LostMoonkin',
        repo: 'ashare-volpulse',
        issueNumber: 99,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/Pull Request/);

    await expect(
      postIssueComment({
        token: tokenRes.token,
        owner: 'LostMoonkin',
        repo: 'ashare-volpulse',
        issueNumber: 11,
        body: '   ',
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/不能为空/);

    const posted = await postIssueComment({
      token: tokenRes.token,
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
      issueNumber: 11,
      body: '已确认并在核查中。',
      fetchImpl: mockFetch,
    });
    expect(posted.author).toBe('ashare-volpulse-bot[bot]');

    const afterAdd = await addIssueLabels({
      token: tokenRes.token,
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
      issueNumber: 11,
      labels: ['triage'],
      fetchImpl: mockFetch,
    });
    expect(afterAdd).toEqual(['enhancement', 'triage']);

    const afterRemove = await removeIssueLabel({
      token: tokenRes.token,
      owner: 'LostMoonkin',
      repo: 'ashare-volpulse',
      issueNumber: 11,
      label: 'triage',
      fetchImpl: mockFetch,
    });
    expect(afterRemove).toEqual(['enhancement']);

    const failingFetch: typeof fetch = async () =>
      createMockResponse(401, {
        message: `Bad token ghs_secret_install_token_123456 and jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJl ${privateKey}`,
      });

    await expect(
      listIssues({
        token: 'ghs_secret_install_token_123456',
        owner: 'LostMoonkin',
        repo: 'ashare-volpulse',
        fetchImpl: failingFetch,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain('HTTP 401');
      expect(error.message).not.toContain('ghs_secret_install_token_123456');
      expect(error.message).not.toContain('eyJhbGciOiJSUzI1NiJ9');
      expect(error.message).not.toContain('PRIVATE KEY');
      return true;
    });

    const sanitized = sanitizeErrorMessage(
      'leak ghs_1234567890 and custom-secret',
      ['custom-secret'],
    );
    expect(sanitized).toBe('leak [REDACTED] and [REDACTED]');
  });

  it('parseCliArgs 与 CLI 入口正确处理 help 与异常参数', () => {
    expect(parseCliArgs(['help']).command).toBe('help');
    expect(parseCliArgs(['--help']).command).toBe('help');
    expect(parseCliArgs(['list', '--needs-reply', '--limit', '10'])).toMatchObject({
      command: 'list',
      needsReply: true,
      limit: 10,
    });
    expect(
      parseCliArgs(['reply', '5', '--body-file', 'reply.md', '--dry-run']),
    ).toMatchObject({
      command: 'reply',
      issueNumber: 5,
      bodyFile: 'reply.md',
      dryRun: true,
    });
    expect(() => parseCliArgs(['reply', '5', '--body', 'a', '--body-file', 'b'])).toThrow(
      /只能指定/,
    );
    expect(() => parseCliArgs(['unknown-cmd'])).toThrow(/未知子命令/);

    const scriptPath = resolve('scripts/github-issue-bot.mjs');
    const helpOut = execFileSync(process.execPath, [scriptPath, 'help'], {
      encoding: 'utf8',
    });
    expect(helpOut).toContain('whoami');
    expect(helpOut).toContain('list');
    expect(helpOut).toContain('reply');

    expect(() =>
      execFileSync(process.execPath, [scriptPath, 'whoami', '--config', 'not-found-bot.json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow();
  });
});
