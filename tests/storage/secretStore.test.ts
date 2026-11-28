import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseCredentialsEnv,
  resolveDefaultCredentialsEnvPath,
  SecretStore,
  type SafeStorageAdapter,
} from '../../src/main/storage/secretStore';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashare-volpulse-secret-test-'));
  tempDirs.push(dir);
  return dir;
}

/** 轻量可逆加密桩（用 XOR + 前缀模拟加密字节流，确保落盘内容不含明文） */
function createMockSafeStorage(available = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => {
      const buf = Buffer.from(plainText, 'utf8');
      const masked = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) {
        masked[i] = buf[i] ^ 0x5a;
      }
      return Buffer.concat([Buffer.from('ENCv1:'), masked]);
    },
    decryptString: (encrypted: Buffer) => {
      const prefix = encrypted.subarray(0, 6).toString('utf8');
      if (prefix !== 'ENCv1:') {
        throw new Error('Invalid ciphertext');
      }
      const body = encrypted.subarray(6);
      const plain = Buffer.alloc(body.length);
      for (let i = 0; i < body.length; i++) {
        plain[i] = body[i] ^ 0x5a;
      }
      return plain.toString('utf8');
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseCredentialsEnv', () => {
  it('parses plain, quoted, export-prefixed, and commented env entries', () => {
    expect(parseCredentialsEnv('HITHINK_FINANCE_API_KEY=plain-key-123\n')).toBe('plain-key-123');
    expect(parseCredentialsEnv('# comment\nexport HITHINK_FINANCE_API_KEY="quoted-key-456"\n')).toBe(
      'quoted-key-456'
    );
    expect(parseCredentialsEnv("HITHINK_FINANCE_API_KEY='single-789'\n")).toBe('single-789');
    expect(parseCredentialsEnv('HITHINK_FINANCE_API_KEY=key-with-note # inline comment')).toBe(
      'key-with-note'
    );
    expect(parseCredentialsEnv('\uFEFFHITHINK_FINANCE_API_KEY=bom-key\n')).toBe('bom-key');
    expect(parseCredentialsEnv('HITHINK_FINANCE_API_KEY="quoted-secret" # inline note\n')).toBe(
      'quoted-secret'
    );
    expect(parseCredentialsEnv("HITHINK_FINANCE_API_KEY='single#hash' # inline note\n")).toBe(
      'single#hash'
    );
    expect(parseCredentialsEnv('HITHINK_FINANCE_API_KEY="" # empty\n')).toBeNull();
    expect(parseCredentialsEnv('OTHER_KEY=abc\n')).toBeNull();
  });
});

describe('SecretStore', () => {
  it('resolves each individual source correctly and returns none when unconfigured', () => {
    const dir = createTempDir();
    const encPath = path.join(dir, 'hithink-key.enc');
    const credPath = path.join(dir, 'credentials.env');

    // 1. 均不存在
    const emptyStore = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createMockSafeStorage(true),
      env: {},
      credentialsEnvPath: credPath,
    });
    expect(emptyStore.getApiKey()).toBeNull();
    expect(emptyStore.getStatus()).toEqual({
      configured: false,
      source: 'none',
      encryptionAvailable: true,
    });

    // 2. 仅 credentials.env
    fs.writeFileSync(credPath, 'HITHINK_FINANCE_API_KEY="file-secret-key"\n', 'utf8');
    expect(emptyStore.getApiKey()).toBe('file-secret-key');
    expect(emptyStore.getStatus()).toEqual({
      configured: true,
      source: 'credentialsFile',
      encryptionAvailable: true,
    });

    // 3. 仅环境变量
    const envOnlyStore = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createMockSafeStorage(true),
      env: { HITHINK_FINANCE_API_KEY: 'env-secret-key' },
      credentialsEnvPath: path.join(dir, 'missing.env'),
    });
    expect(envOnlyStore.getApiKey()).toBe('env-secret-key');
    expect(envOnlyStore.getStatus()).toEqual({
      configured: true,
      source: 'env',
      encryptionAvailable: true,
    });

    // 4. 仅 safeStorage
    const safeOnlyStore = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createMockSafeStorage(true),
      env: {},
      credentialsEnvPath: path.join(dir, 'missing.env'),
    });
    safeOnlyStore.setStoredApiKey('safe-secret-key');
    expect(safeOnlyStore.getApiKey()).toBe('safe-secret-key');
    expect(safeOnlyStore.getStatus()).toEqual({
      configured: true,
      source: 'safeStorage',
      encryptionAvailable: true,
    });

    // 验证磁盘上落盘内容不是明文
    const rawOnDisk = fs.readFileSync(encPath, 'utf8');
    expect(rawOnDisk).not.toContain('safe-secret-key');
  });

  it('enforces priority safeStorage > env > credentialsFile and falls back cleanly on clear', () => {
    const dir = createTempDir();
    const encPath = path.join(dir, 'hithink-key.enc');
    const credPath = path.join(dir, 'credentials.env');
    fs.writeFileSync(credPath, 'HITHINK_FINANCE_API_KEY=key-from-file\n', 'utf8');

    const env: NodeJS.ProcessEnv = { HITHINK_FINANCE_API_KEY: 'key-from-env' };
    const store = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createMockSafeStorage(true),
      env,
      credentialsEnvPath: credPath,
    });

    // env + credentialsFile 同时存在 → 选 env
    expect(store.getApiKey()).toBe('key-from-env');
    expect(store.getStatus().source).toBe('env');

    // 三者同时存在 → 选 safeStorage
    store.setStoredApiKey('key-from-safe-storage');
    expect(store.getApiKey()).toBe('key-from-safe-storage');
    expect(store.getStatus().source).toBe('safeStorage');

    // 清除 safeStorage 后 → 回落至 env
    store.clearStoredApiKey();
    expect(fs.existsSync(encPath)).toBe(false);
    expect(store.getApiKey()).toBe('key-from-env');
    expect(store.getStatus().source).toBe('env');

    // 移除 env 后 → 回落至 credentialsFile
    delete env.HITHINK_FINANCE_API_KEY;
    expect(store.getApiKey()).toBe('key-from-file');
    expect(store.getStatus().source).toBe('credentialsFile');
  });

  it('never leaks plaintext key in status response and rejects empty or unavailable writes', () => {
    const dir = createTempDir();
    const encPath = path.join(dir, 'hithink-key.enc');
    const secret = 'SUPER-SENSITIVE-THS-KEY-987654321';

    const store = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createMockSafeStorage(true),
      env: {},
      credentialsEnvPath: path.join(dir, 'missing.env'),
    });

    store.setStoredApiKey(secret);
    const statusJson = JSON.stringify(store.getStatus());
    expect(statusJson).not.toContain(secret);
    expect(statusJson).not.toContain('987654321');
    expect(statusJson).not.toContain('SUPER-SENSITIVE');

    expect(() => store.setStoredApiKey('   ')).toThrow();

    // 当 OS 加密不可用时，写入应报错，且读取安全降级到 env
    const unavailableStore = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createMockSafeStorage(false),
      env: { HITHINK_FINANCE_API_KEY: 'fallback-env-key' },
      credentialsEnvPath: path.join(dir, 'missing.env'),
    });
    expect(() => unavailableStore.setStoredApiKey('new-key')).toThrow();
    expect(unavailableStore.getApiKey()).toBe('fallback-env-key');
    expect(unavailableStore.getStatus()).toEqual({
      configured: true,
      source: 'env',
      encryptionAvailable: false,
    });
  });

  it('does not fall back to a relative credentials.env path in cwd when APPDATA is unset', () => {
    const dir = createTempDir();
    const origCwd = process.cwd();
    try {
      fs.mkdirSync(path.join(dir, 'hithink-finance'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'hithink-finance', 'credentials.env'),
        'HITHINK_FINANCE_API_KEY=should-not-be-read-from-cwd\n',
        'utf8'
      );
      process.chdir(dir);

      const store = new SecretStore({
        encryptedFilePath: path.join(dir, 'missing.enc'),
        safeStorage: createMockSafeStorage(false),
        platform: 'win32',
        env: {},
      });

      expect(store.getApiKey()).toBeNull();
      expect(store.getStatus()).toEqual({
        configured: false,
        source: 'none',
        encryptionAvailable: false,
      });
    } finally {
      process.chdir(origCwd);
    }
  });

  it('resolves platform-specific credentials.env paths for Windows, macOS, and Linux', () => {
    const dir = createTempDir();
    const macCredDir = path.join(dir, 'Library', 'Application Support', 'hithink-finance');
    fs.mkdirSync(macCredDir, { recursive: true });
    fs.writeFileSync(
      path.join(macCredDir, 'credentials.env'),
      'HITHINK_FINANCE_API_KEY="mac-file-secret"\n',
      'utf8'
    );

    expect(resolveDefaultCredentialsEnvPath('win32', { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' })).toBe(
      path.join('C:\\Users\\demo\\AppData\\Roaming', 'hithink-finance', 'credentials.env')
    );
    expect(resolveDefaultCredentialsEnvPath('darwin', {}, dir)).toBe(
      path.join(dir, 'Library', 'Application Support', 'hithink-finance', 'credentials.env')
    );
    expect(resolveDefaultCredentialsEnvPath('linux', { XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/demo')).toBe(
      path.join('/tmp/xdg', 'hithink-finance', 'credentials.env')
    );

    const macStore = new SecretStore({
      encryptedFilePath: path.join(dir, 'missing.enc'),
      safeStorage: createMockSafeStorage(false),
      platform: 'darwin',
      homeDir: dir,
      env: {},
    });
    expect(macStore.getApiKey()).toBe('mac-file-secret');
    expect(macStore.getStatus().source).toBe('credentialsFile');
  });

  it('uses Electron 45+ async safeStorage APIs exclusively without invoking deprecated sync methods', async () => {
    const dir = createTempDir();
    const encPath = path.join(dir, 'hithink-key.enc');

    const deprecatedSyncSpy = vi.fn(() => {
      throw new Error('Deprecated sync safeStorage method must not be called');
    });

    let shouldReEncryptNext = false;
    const createAsyncAdapter = (available = true): SafeStorageAdapter => ({
      isAsyncEncryptionAvailable: async () => available,
      encryptStringAsync: async (plainText: string) => {
        const buf = Buffer.from(plainText, 'utf8');
        const masked = Buffer.alloc(buf.length);
        for (let i = 0; i < buf.length; i++) {
          masked[i] = buf[i] ^ 0x5a;
        }
        return Buffer.concat([Buffer.from('ENCv2:'), masked]);
      },
      decryptStringAsync: async (encrypted: Buffer) => {
        const prefix = encrypted.subarray(0, 6).toString('utf8');
        if (prefix !== 'ENCv1:' && prefix !== 'ENCv2:') {
          throw new Error('Invalid ciphertext');
        }
        const body = encrypted.subarray(6);
        const plain = Buffer.alloc(body.length);
        for (let i = 0; i < body.length; i++) {
          plain[i] = body[i] ^ 0x5a;
        }
        const reEncrypt = shouldReEncryptNext;
        shouldReEncryptNext = false;
        return { result: plain.toString('utf8'), shouldReEncrypt: reEncrypt };
      },
      // 同时挂载废弃同步方法桩：若被误调用会立即触发断言失败
      isEncryptionAvailable: deprecatedSyncSpy,
      encryptString: deprecatedSyncSpy,
      decryptString: deprecatedSyncSpy,
    });

    const store1 = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createAsyncAdapter(true),
      env: {},
      credentialsEnvPath: path.join(dir, 'missing.env'),
    });

    await store1.initialize();
    expect(await store1.getStatusAsync()).toEqual({
      configured: false,
      source: 'none',
      encryptionAvailable: true,
    });

    // 异步加密保存后：立即反映至同步 getApiKey() 与 getStatus()，且磁盘无明文
    await store1.setStoredApiKeyAsync('async-secret-key-001');
    expect(store1.getApiKey()).toBe('async-secret-key-001');
    expect(store1.getStatus()).toEqual({
      configured: true,
      source: 'safeStorage',
      encryptionAvailable: true,
    });
    expect(fs.readFileSync(encPath, 'utf8')).not.toContain('async-secret-key-001');

    // 模拟重启并触发 shouldReEncrypt：新实例 initialize() 应解密并自动异步重加密回写
    shouldReEncryptNext = true;
    const store2 = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createAsyncAdapter(true),
      env: {},
      credentialsEnvPath: path.join(dir, 'missing.env'),
    });
    await store2.initialize();
    expect(store2.getApiKey()).toBe('async-secret-key-001');
    expect(fs.readFileSync(encPath).subarray(0, 6).toString('utf8')).toBe('ENCv2:');

    // 清除凭据后立即失效
    store2.clearStoredApiKey();
    expect(store2.getApiKey()).toBeNull();
    expect(await store2.getStatusAsync()).toEqual({
      configured: false,
      source: 'none',
      encryptionAvailable: true,
    });

    // 异步不可用时拒绝写入并回退 env
    const unavailableAsyncStore = new SecretStore({
      encryptedFilePath: encPath,
      safeStorage: createAsyncAdapter(false),
      env: { HITHINK_FINANCE_API_KEY: 'env-fallback-key' },
      credentialsEnvPath: path.join(dir, 'missing.env'),
    });
    await unavailableAsyncStore.initialize();
    await expect(unavailableAsyncStore.setStoredApiKeyAsync('blocked-key')).rejects.toThrow();
    expect(unavailableAsyncStore.getApiKey()).toBe('env-fallback-key');
    expect(await unavailableAsyncStore.getStatusAsync()).toEqual({
      configured: true,
      source: 'env',
      encryptionAvailable: false,
    });

    expect(deprecatedSyncSpy).not.toHaveBeenCalled();
  });
});
