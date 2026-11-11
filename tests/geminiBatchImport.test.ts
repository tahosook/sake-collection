import { describe, it, expect, vi } from 'vitest';
import {
  MAX_GEMINI_BATCH_SIZE,
  extractJsonFromText,
  validateAndNormalizeCropBox,
  parseAndValidateGeminiJson,
  parseAndValidateGeminiBatchJson,
  parseAndValidateGeminiInput,
  buildGeminiConsultationPrompt,
  GeminiImportPayload,
} from '../src/domain/geminiPrompt';
import {
  calculateCropPixelRect,
  cropPhotoRecordToNewPhotoRecord,
} from '../src/domain/photoUtils';
import {
  createBottlesFromGeminiBatch,
  detectIntraBatchDuplicates,
  createBottlesBatch,
} from '../src/domain/bottleUtils';
import { PhotoRecord } from '../src/types/sake';
import { SAMPLE_PHOTOS } from '../src/data/sampleData';

describe('Gemini 相談結果の配列一括取り込み (PR 1: ドメインロジック)', () => {
  describe('1. 配列 JSON 抽出 (extractJsonFromText)', () => {
    it('コードブロック付きの JSON 配列を正確に抽出できること', () => {
      const input = '```json\n[{"name": "ワインA"}, {"name": "ワインB"}]\n```';
      expect(extractJsonFromText(input)).toBe('[{"name": "ワインA"}, {"name": "ワインB"}]');
    });

    it('コードブロックなしの生の JSON 配列を抽出できること', () => {
      const input = '  [{"name": "ワインA"}, {"name": "ワインB"}]  ';
      expect(extractJsonFromText(input)).toBe('[{"name": "ワインA"}, {"name": "ワインB"}]');
    });

    it('前後に説明テキストが含まれる場合でも [ から ] までを抽出できること', () => {
      const input = 'Gemini の回答です:\n[{"name": "ワインA"}]\n以上です。参考になれば幸いです。';
      expect(extractJsonFromText(input)).toBe('[{"name": "ワインA"}]');
    });

    it('単一オブジェクト { ... } も従来通り抽出できること (後方互換性)', () => {
      const input = '回答です:\n{"name": "獺祭", "category": "日本酒"}\n確認してください。';
      expect(extractJsonFromText(input)).toBe('{"name": "獺祭", "category": "日本酒"}');
    });
  });

  describe('2. cropBox の検証と正規化 (validateAndNormalizeCropBox)', () => {
    it('正常な 0..1000 整数オブジェクトをそのまま受理すること', () => {
      const result = validateAndNormalizeCropBox({
        ymin: 100,
        xmin: 150,
        ymax: 900,
        xmax: 400,
      });
      expect(result.warning).toBeUndefined();
      expect(result.cropBox).toEqual({
        ymin: 100,
        xmin: 150,
        ymax: 900,
        xmax: 400,
      });
    });

    it('配列形式 [ymin, xmin, ymax, xmax] を正規化オブジェクトに変換できること', () => {
      const result = validateAndNormalizeCropBox([80, 120, 920, 310]);
      expect(result.warning).toBeUndefined();
      expect(result.cropBox).toEqual({
        ymin: 80,
        xmin: 120,
        ymax: 920,
        xmax: 310,
      });
    });

    it('0.0〜1.0 の小数形式を 0〜1000 の整数値に自動スケールすること', () => {
      const result = validateAndNormalizeCropBox({
        ymin: 0.1,
        xmin: 0.2,
        ymax: 0.9,
        xmax: 0.5,
      });
      expect(result.warning).toBeUndefined();
      expect(result.cropBox).toEqual({
        ymin: 100,
        xmin: 200,
        ymax: 900,
        xmax: 500,
      });
    });

    it('未指定 (undefined, null, 空文字) の場合は警告なしで cropBox: null を返すこと', () => {
      expect(validateAndNormalizeCropBox(undefined)).toEqual({ cropBox: null });
      expect(validateAndNormalizeCropBox(null)).toEqual({ cropBox: null });
      expect(validateAndNormalizeCropBox('')).toEqual({ cropBox: null });
    });

    it('座標が逆転している場合は警告付きで cropBox: null にフォールバックすること', () => {
      const result = validateAndNormalizeCropBox({
        ymin: 800,
        xmin: 500,
        ymax: 200, // ymax < ymin
        xmax: 800,
      });
      expect(result.cropBox).toBeNull();
      expect(result.warning).toContain('開始座標と終了座標が逆転');
    });

    it('切り抜きサイズが極小 (幅・高さが3%未満: 30未満) の場合は警告付きで cropBox: null にフォールバックすること', () => {
      const result = validateAndNormalizeCropBox({
        ymin: 100,
        xmin: 100,
        ymax: 120, // 高さ 20 (< 30)
        xmax: 500,
      });
      expect(result.cropBox).toBeNull();
      expect(result.warning).toContain('極小（3%未満）');
    });
  });

  describe('3. 配列検証と上限6本ルール (parseAndValidateGeminiBatchJson)', () => {
    it('1〜6件の有効な配列データが受理され、全件検証されること', () => {
      const batchData = [
        { name: 'スパークリング A', category: 'ワイン', abv: 12, volumeMl: 750 },
        { name: 'スパークリング B', category: 'ワイン', abv: 11.5, volumeMl: 750 },
        { name: 'スパークリング C', category: 'ワイン', abv: 12.5, volumeMl: 750 },
        { name: 'スパークリング D', category: 'ワイン', abv: 12, volumeMl: 750 },
      ];

      const res = parseAndValidateGeminiBatchJson(batchData);
      expect(res.globalErrors).toHaveLength(0);
      expect(res.totalCount).toBe(4);
      expect(res.validCount).toBe(4);
      expect(res.items).toHaveLength(4);
      expect(res.items.every((it) => it.success)).toBe(true);
    });

    it(`上限の ${MAX_GEMINI_BATCH_SIZE} 本ちょうどの配列が受理されること`, () => {
      const batchData = Array.from({ length: 6 }, (_, i) => ({
        name: `ワイン ${i + 1}`,
        category: 'ワイン',
      }));

      const res = parseAndValidateGeminiBatchJson(batchData);
      expect(res.globalErrors).toHaveLength(0);
      expect(res.totalCount).toBe(6);
      expect(res.validCount).toBe(6);
    });

    it('7件以上の配列は最大6本超過エラーとして弾かれること', () => {
      const batchData = Array.from({ length: 7 }, (_, i) => ({
        name: `ワイン ${i + 1}`,
        category: 'ワイン',
      }));

      const res = parseAndValidateGeminiBatchJson(batchData);
      expect(res.globalErrors.length).toBeGreaterThan(0);
      expect(res.globalErrors[0]).toContain(`一度に取り込めるのは最大${MAX_GEMINI_BATCH_SIZE}本までです（検出件数: 7本）`);
      expect(res.validCount).toBe(0);
    });

    it('空の配列 [] はエラーとなること', () => {
      const res = parseAndValidateGeminiBatchJson([]);
      expect(res.globalErrors).toContain('取り込みデータが空の配列です。');
    });

    it('一部に不正な要素（名前欠落、未知種類）がある場合、有効なものと無効なものが正しく仕分けられること (部分許容)', () => {
      const batchData = [
        { name: 'シャンパーニュ シャルル', category: 'ワイン', volumeMl: 750 },
        { name: '', category: 'ワイン' }, // 名前欠落
        { name: '謎のサワー', category: 'チューハイ' }, // 未知種類
        {
          name: 'カヴァ ブリュット',
          category: 'ワイン',
          cropBox: { ymin: 100, xmin: 100, ymax: 900, xmax: 400 },
        },
      ];

      const res = parseAndValidateGeminiBatchJson(batchData);
      expect(res.globalErrors).toHaveLength(0);
      expect(res.totalCount).toBe(4);
      expect(res.validCount).toBe(2);

      // 1本目: 有効
      expect(res.items[0]!.success).toBe(true);
      expect(res.items[0]!.data?.name).toBe('シャンパーニュ シャルル');

      // 2本目: 無効 (名前欠落)
      expect(res.items[1]!.success).toBe(false);
      expect(res.items[1]!.errors.some((e) => e.includes('名前'))).toBe(true);

      // 3本目: 無効 (未知種類)
      expect(res.items[2]!.success).toBe(false);
      expect(res.items[2]!.errors.some((e) => e.includes('チューハイ'))).toBe(true);

      // 4本目: 有効 (cropBox あり)
      expect(res.items[3]!.success).toBe(true);
      expect(res.items[3]!.data?.cropBox).toEqual({
        ymin: 100,
        xmin: 100,
        ymax: 900,
        xmax: 400,
      });
    });
  });

  describe('4. 単一・配列判別エントリーポイント (parseAndValidateGeminiInput)', () => {
    it('単一オブジェクトを渡すと kind: single として返ること', () => {
      const json = JSON.stringify({ name: '獺祭', category: '日本酒' });
      const res = parseAndValidateGeminiInput(json);
      expect(res.kind).toBe('single');
      if (res.kind === 'single') {
        expect(res.result.success).toBe(true);
        if (res.result.success) {
          expect(res.result.data.name).toBe('獺祭');
        }
      }
    });

    it('配列を渡すと kind: batch として返ること', () => {
      const json = JSON.stringify([{ name: '獺祭', category: '日本酒' }]);
      const res = parseAndValidateGeminiInput(json);
      expect(res.kind).toBe('batch');
      if (res.kind === 'batch') {
        expect(res.result.validCount).toBe(1);
      }
    });
  });

  describe('5. 切り抜きピクセル計算 (calculateCropPixelRect)', () => {
    it('1600x1200 の元画像に対して 0..1000 の cropBox から正確なピクセル矩形を算出すること', () => {
      const origW = 1600;
      const origH = 1200;
      const cropBox = {
        ymin: 100, // 1200 * 0.10 = 120
        xmin: 200, // 1600 * 0.20 = 320
        ymax: 900, // 1200 * 0.90 = 1080 -> height = 960
        xmax: 600, // 1600 * 0.60 = 960 -> width = 640
      };

      const rect = calculateCropPixelRect(origW, origH, cropBox);
      expect(rect).toEqual({
        sx: 320,
        sy: 120,
        sw: 640,
        sh: 960,
      });
    });

    it('境界値が画像の幅・高さを超えないようクランプされること', () => {
      const rect = calculateCropPixelRect(1000, 1000, {
        ymin: 0,
        xmin: 0,
        ymax: 1000,
        xmax: 1000,
      });
      expect(rect).toEqual({
        sx: 0,
        sy: 0,
        sw: 1000,
        sh: 1000,
      });
    });
  });

  describe('6. 写真切り抜き処理 (cropPhotoRecordToNewPhotoRecord)', () => {
    it('元写真レコードと cropBox から新しい PhotoRecord を生成できること', async () => {
      const samplePhoto = SAMPLE_PHOTOS[0]!;

      // DOM Image & Canvas モック
      const originalDocument = globalThis.document;

      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue({
          drawImage: vi.fn(),
        }),
        toDataURL: vi.fn().mockReturnValue(samplePhoto.dataUrl),
      };

      globalThis.document = {
        createElement: vi.fn((tagName: string) => {
          if (tagName === 'canvas') {
            return mockCanvas as unknown as HTMLCanvasElement;
          }
          if (tagName === 'img') {
            const img = {
              naturalWidth: 1600,
              naturalHeight: 1200,
              src: '',
              onload: null as (() => void) | null,
            };
            setTimeout(() => {
              if (img.onload) img.onload();
            }, 0);
            return img as unknown as HTMLImageElement;
          }
          return {} as HTMLElement;
        }),
      } as unknown as Document;

      try {
        const cropBox = { ymin: 100, xmin: 100, ymax: 900, xmax: 400 };
        const cropped = await cropPhotoRecordToNewPhotoRecord(
          samplePhoto,
          cropBox,
          'target-bottle-123'
        );

        expect(cropped.bottleId).toBe('target-bottle-123');
        expect(cropped.id).not.toBe(samplePhoto.id);
        expect(cropped.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(cropped.mimeType).toBe('image/jpeg');
        expect(cropped.contentHash).toBe(samplePhoto.contentHash);
        expect(cropped.byteSize).toBe(samplePhoto.byteSize);
      } finally {
        globalThis.document = originalDocument;
      }
    });
  });

  describe('7. バッチボトル生成純粋関数 (createBottlesFromGeminiBatch)', () => {
    it('選択されたペイロードから独立した BottleRecord 群と photosToSave 群が生成されること', () => {
      const items: GeminiImportPayload[] = [
        {
          name: 'ワインA',
          category: 'ワイン',
          abv: 12,
          volumeMl: 750,
          categoryAttributes: {},
          description: null,
          sources: [],
          referencePrice: null,
        },
        {
          name: 'ワインB',
          category: 'ワイン',
          abv: 13,
          volumeMl: 750,
          categoryAttributes: {},
          description: null,
          sources: [],
          referencePrice: null,
        },
      ];

      const dummyPhoto: PhotoRecord = {
        id: 'photo-cropped-1',
        bottleId: 'temp',
        mimeType: 'image/jpeg',
        dataUrl: 'data:image/jpeg;base64,dummy',
        width: 400,
        height: 800,
        byteSize: 1000,
        contentHash: 'hash-cropped-1',
        driveFileId: null,
        createdAt: '2026-11-11T00:00:00Z',
        updatedAt: '2026-11-11T00:00:00Z',
        deleted: false,
      };

      const croppedPhotos = [dummyPhoto, null]; // 1本目は写真あり、2本目は写真なし

      const result = createBottlesFromGeminiBatch(items, croppedPhotos, {
        nowIso: '2026-11-11T12:00:00Z',
      });

      expect(result.bottles).toHaveLength(2);
      expect(result.bottles[0]!.id).not.toBe(result.bottles[1]!.id);
      expect(result.bottles[0]!.status).toBe('unopened');

      // 1本目: 写真あり
      expect(result.bottles[0]!.photoIds).toHaveLength(1);
      expect(result.bottles[0]!.primaryPhotoId).toBe('photo-cropped-1');
      expect(result.photosToSave).toHaveLength(1);
      expect(result.photosToSave[0]!.bottleId).toBe(result.bottles[0]!.id);

      // 2本目: 写真なし
      expect(result.bottles[1]!.photoIds).toHaveLength(0);
      expect(result.bottles[1]!.primaryPhotoId).toBeNull();
    });
  });

  describe('8. セット内重複銘柄検出 (detectIntraBatchDuplicates)', () => {
    it('同一種類かつ同名銘柄が含まれる場合に正しくインデックスと重複数が返ること', () => {
      const items = [
        { name: 'ヴーヴ・クリコ イエローラベル', category: 'ワイン' as const },
        { name: 'モエ・エ・シャンドン', category: 'ワイン' as const },
        { name: 'ヴーヴ・クリコ　イエローラベル', category: 'ワイン' as const }, // 全角スペース同名
      ];

      const dupes = detectIntraBatchDuplicates(items);
      expect(dupes[0]!.hasDuplicate).toBe(true);
      expect(dupes[0]!.duplicateCount).toBe(2);
      expect(dupes[0]!.matchingIndices).toEqual([0, 2]);

      expect(dupes[1]!.hasDuplicate).toBe(false);
      expect(dupes[1]!.duplicateCount).toBe(1);

      expect(dupes[2]!.hasDuplicate).toBe(true);
      expect(dupes[2]!.duplicateCount).toBe(2);
      expect(dupes[2]!.matchingIndices).toEqual([0, 2]);
    });

    it('種類が異なる場合は同名でも重複と判定されないこと', () => {
      const items = [
        { name: '山崎', category: 'ウイスキー' as const },
        { name: '山崎', category: 'その他' as const },
      ];

      const dupes = detectIntraBatchDuplicates(items);
      expect(dupes[0]!.hasDuplicate).toBe(false);
      expect(dupes[1]!.hasDuplicate).toBe(false);
    });
  });

  describe('9. 既存機能との非破壊検証', () => {
    it('単一オブジェクト取り込み (parseAndValidateGeminiJson) が従来どおり二段階検証を行うこと', () => {
      const singleJson = {
        name: '獺祭 純米大吟醸 45',
        category: '日本酒',
        abv: 16,
        volumeMl: 720,
      };

      const res = parseAndValidateGeminiJson(singleJson);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.name).toBe('獺祭 純米大吟醸 45');
        expect(res.data.cropBox).toBeNull();
      }
    });

    it('同一銘柄の複数本登録 (createBottlesBatch) の上限10本が変更されていないこと', () => {
      const batchResult = createBottlesBatch(
        { name: '獺祭', category: '日本酒' },
        10
      );
      expect(batchResult.bottles).toHaveLength(10);
    });

    it('相談プロンプトに cropBox および最大6本配列の指示が含まれていること', () => {
      const prompt = buildGeminiConsultationPrompt();
      expect(prompt).toContain('cropBox');
      expect(prompt).toContain('最大6本まで');
    });
  });
});
