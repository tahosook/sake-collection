import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateUuid } from '../src/domain/uuid';
import { createNewBottle } from '../src/domain/bottleUtils';

// RFC 4122 v4 UUID の正規表現
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuid', () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    vi.restoreAllMocks();
    // globalThis.crypto を元のオブジェクトに復元
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  it('セキュア環境（crypto.randomUUID が利用可能）で正しい UUID v4 を生成できる', () => {
    const uuid = generateUuid();
    expect(uuid).toMatch(UUID_V4_REGEX);
    expect(uuid.length).toBe(36);

    // 複数回呼び出して重複しないこと
    const uuid2 = generateUuid();
    expect(uuid2).toMatch(UUID_V4_REGEX);
    expect(uuid).not.toBe(uuid2);
  });

  it('非セキュア環境（HTTP LAN など crypto.randomUUID が undefined）で getRandomValues にフォールバックして UUID v4 を生成できる', () => {
    // crypto.randomUUID を undefined に模倣
    const mockCrypto = {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        return originalCrypto.getRandomValues(array);
      },
      randomUUID: undefined,
    };

    Object.defineProperty(globalThis, 'crypto', {
      value: mockCrypto,
      writable: true,
      configurable: true,
    });

    expect(globalThis.crypto.randomUUID).toBeUndefined();

    const uuid = generateUuid();
    expect(uuid).toMatch(UUID_V4_REGEX);
    expect(uuid.length).toBe(36);

    // バージョン 4 (7番目ブロックが 4xxx) および バリアント 1 (9番目ブロックが 8, 9, a, b のいずれか) を確認
    const parts = uuid.split('-');
    expect(parts.length).toBe(5);
    expect(parts[2]?.startsWith('4')).toBe(true);
    expect(/^[89ab]/i.test(parts[3] ?? '')).toBe(true);

    // 複数回生成して一意性を確認
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const generated = generateUuid();
      expect(generated).toMatch(UUID_V4_REGEX);
      set.add(generated);
    }
    expect(set.size).toBe(50);
  });

  it('安全な乱数源（crypto.randomUUID および crypto.getRandomValues）が存在しない場合は明示的にエラーを投げること', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    expect(() => generateUuid()).toThrow('暗号論的疑似乱数生成器（Web Crypto API）が利用できないため、UUID を生成できません。');
  });

  it('crypto オブジェクトはあるが getRandomValues も randomUUID も利用できない場合は明示的にエラーを投げること', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      writable: true,
      configurable: true,
    });

    expect(() => generateUuid()).toThrow('暗号論的疑似乱数生成器（Web Crypto API）が利用できないため、UUID を生成できません。');
  });

  it('非セキュア環境下で createNewBottle を呼び出しても例外なく UUID が生成されてボトルが作成できる', () => {
    const mockCrypto = {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        return originalCrypto.getRandomValues(array);
      },
      randomUUID: undefined,
    };

    Object.defineProperty(globalThis, 'crypto', {
      value: mockCrypto,
      writable: true,
      configurable: true,
    });

    const bottle = createNewBottle({
      name: '獺祭 純米大吟醸 45',
      category: '日本酒',
    });

    expect(bottle.id).toMatch(UUID_V4_REGEX);
    expect(bottle.name).toBe('獺祭 純米大吟醸 45');
  });
});
