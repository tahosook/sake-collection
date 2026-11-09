import nodeCrypto from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeSha256, sha256Fallback } from '../src/domain/sha256';
import { computeDataUrlHashAndSize, processImageFileToPhotoRecord } from '../src/domain/photoUtils';
import { SAMPLE_PHOTOS } from '../src/data/sampleData';

describe('SHA-256 ハッシュ計算および非セキュア環境フォールバック', () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  describe('既知のテストベクトル (NIST / RFC 6234 準拠)', () => {
    const knownVectors = [
      {
        input: '',
        expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      {
        input: 'abc',
        expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
      {
        input: 'hello world',
        expected: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      },
      {
        input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        expected: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      },
    ];

    it('sha256Fallback が既知のテストベクトルのハッシュ値と完全一致すること', () => {
      const encoder = new TextEncoder();
      for (const { input, expected } of knownVectors) {
        const bytes = encoder.encode(input);
        const hash = sha256Fallback(bytes);
        expect(hash).toBe(expected);
      }
    });

    it('computeSha256 が既知のテストベクトルのハッシュ値と完全一致すること', async () => {
      const encoder = new TextEncoder();
      for (const { input, expected } of knownVectors) {
        const bytes = encoder.encode(input);
        const hash = await computeSha256(bytes);
        expect(hash).toBe(expected);
      }
    });
  });

  describe('Node.js 標準 crypto との完全一致検証', () => {
    it('境界値サイズ（55, 56, 63, 64, 65, 128, 1000バイト等）のバイナリで一致すること', () => {
      const sizes = [0, 1, 2, 55, 56, 63, 64, 65, 127, 128, 129, 500, 1000, 10000];
      for (const size of sizes) {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          bytes[i] = (i * 37 + 13) & 0xff;
        }
        const expected = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
        const actual = sha256Fallback(bytes);
        expect(actual).toBe(expected);
      }
    });

    it('マルチバイト日本語文字列で一致すること', () => {
      const texts = [
        '獺祭 純米大吟醸 45',
        '十四代 中取り純米 無濾過生',
        '山崎 12年 シングルモルトウイスキー',
        'お酒コレクション - 非セキュアコンテキスト(HTTP LAN)対応',
      ];
      const encoder = new TextEncoder();
      for (const text of texts) {
        const bytes = encoder.encode(text);
        const expected = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
        const actual = sha256Fallback(bytes);
        expect(actual).toBe(expected);
      }
    });
  });

  describe('非セキュア環境（crypto.subtle が undefined）でのフォールバック動作', () => {
    it('crypto.subtle が未定義の環境で computeSha256 がフォールバックして正確なハッシュを返すこと', async () => {
      // crypto.subtle を undefined に模倣（HTTP LAN 環境）
      const mockCrypto = {
        getRandomValues: <T extends ArrayBufferView>(array: T): T => originalCrypto.getRandomValues(array),
        randomUUID: originalCrypto.randomUUID?.bind(originalCrypto),
        subtle: undefined,
      };

      Object.defineProperty(globalThis, 'crypto', {
        value: mockCrypto,
        writable: true,
        configurable: true,
      });

      expect(globalThis.crypto.subtle).toBeUndefined();

      const input = new TextEncoder().encode('LAN環境での写真ハッシュ計算テスト');
      const expected = nodeCrypto.createHash('sha256').update(input).digest('hex');

      const result = await computeSha256(input);
      expect(result).toBe(expected);
    });

    it('crypto.subtle が未定義の環境で computeDataUrlHashAndSize が例外を投げずに正確な contentHash と byteSize を返すこと', async () => {
      const mockCrypto = {
        getRandomValues: <T extends ArrayBufferView>(array: T): T => originalCrypto.getRandomValues(array),
        randomUUID: originalCrypto.randomUUID?.bind(originalCrypto),
        subtle: undefined,
      };

      Object.defineProperty(globalThis, 'crypto', {
        value: mockCrypto,
        writable: true,
        configurable: true,
      });

      expect(globalThis.crypto.subtle).toBeUndefined();

      const samplePhoto = SAMPLE_PHOTOS[0]!;
      const result = await computeDataUrlHashAndSize(samplePhoto.dataUrl);

      expect(result.contentHash).toBe(samplePhoto.contentHash);
      expect(result.byteSize).toBe(samplePhoto.byteSize);
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('crypto.subtle が未定義の環境で写真処理 (processImageFileToPhotoRecord) が最後まで通ること', async () => {
      const mockCrypto = {
        getRandomValues: <T extends ArrayBufferView>(array: T): T => originalCrypto.getRandomValues(array),
        randomUUID: undefined, // 非セキュア環境では randomUUID も subtle も undefined
        subtle: undefined,
      };

      Object.defineProperty(globalThis, 'crypto', {
        value: mockCrypto,
        writable: true,
        configurable: true,
      });

      expect(globalThis.crypto.subtle).toBeUndefined();
      expect(globalThis.crypto.randomUUID).toBeUndefined();

      // ブラウザ Canvas / createImageBitmap のモック
      const originalCreateImageBitmap = globalThis.createImageBitmap;
      const originalDocument = globalThis.document;

      const sampleDataUrl = SAMPLE_PHOTOS[0]!.dataUrl;

      // 擬似 createImageBitmap
      globalThis.createImageBitmap = vi.fn().mockResolvedValue({
        width: 800,
        height: 600,
        close: vi.fn(),
      } as unknown as ImageBitmap);

      // 擬似 document / canvas
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue({
          drawImage: vi.fn(),
        }),
        toDataURL: vi.fn().mockReturnValue(sampleDataUrl),
      };

      globalThis.document = {
        createElement: vi.fn((tagName: string) => {
          if (tagName === 'canvas') {
            return mockCanvas as unknown as HTMLCanvasElement;
          }
          return {} as HTMLElement;
        }),
      } as unknown as Document;

      try {
        const dummyBlob = new Blob(['dummy-binary-data'], { type: 'image/jpeg' });
        const record = await processImageFileToPhotoRecord(dummyBlob, 'test-bottle-uuid');

        // エラーなく完了し、正しいプロパティを持つ PhotoRecord が生成されたことを確認
        expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(record.bottleId).toBe('test-bottle-uuid');
        expect(record.mimeType).toBe('image/jpeg');
        expect(record.width).toBe(800);
        expect(record.height).toBe(600);
        expect(record.contentHash).toBe(SAMPLE_PHOTOS[0]!.contentHash);
        expect(record.byteSize).toBe(SAMPLE_PHOTOS[0]!.byteSize);
        expect(record.dataUrl).toBe(sampleDataUrl);
      } finally {
        globalThis.createImageBitmap = originalCreateImageBitmap;
        globalThis.document = originalDocument;
      }
    });
  });
});
