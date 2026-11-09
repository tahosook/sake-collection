import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createNewBottle,
  createBottlesBatch,
  createReuseDraftFromBottle,
  findDuplicateBottles,
} from '../src/domain/bottleUtils';
import {
  mergeGeminiPayloadIntoBottle,
  GeminiImportPayload,
} from '../src/domain/geminiPrompt';
import {
  addPhotoToDraft,
  removePhotoFromDraft,
  replacePhotoInDraft,
  MAX_PHOTO_COUNT,
} from '../src/domain/photoUtils';
import {
  closeDb,
  clearDatabase,
  saveBottlesBatchWithPhotos,
  getAllBottles,
  getAllPhotos,
  getPhoto,
  exportBackupData,
} from '../src/storage/db';
import { validateBackupData } from '../src/domain/validation';
import { BottleRecord, PhotoRecord, ReferencePriceInfo } from '../src/types/sake';

describe('登録フロー統合ロジックテスト (PR #8)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await closeDb();
  });

  function createDummyPhoto(id: string, bottleId: string): PhotoRecord {
    return {
      id,
      bottleId,
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      width: 800,
      height: 600,
      byteSize: 1024,
      contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      driveFileId: null,
      createdAt: '2026-11-09T10:00:00.000Z',
      updatedAt: '2026-11-09T10:00:00.000Z',
      deleted: false,
    };
  }

  describe('写真管理セクションの操作整合性', () => {
    it('10枚上限に達した場合に例外を投げること', () => {
      const tenIds = Array.from({ length: MAX_PHOTO_COUNT }, (_, i) => `photo-${i}`);
      expect(() => addPhotoToDraft(tenIds, 'photo-11')).toThrow(/最大 10 枚/);
    });

    it('代表写真の削除時に残る写真の先頭が自動昇格すること', () => {
      const ids = ['p1', 'p2', 'p3'];
      const res = removePhotoFromDraft(ids, 'p1', 'p1');
      expect(res.photoIds).toEqual(['p2', 'p3']);
      expect(res.primaryPhotoId).toBe('p2');
    });

    it('非代表写真の削除時に代表写真が維持されること', () => {
      const ids = ['p1', 'p2', 'p3'];
      const res = removePhotoFromDraft(ids, 'p2', 'p1');
      expect(res.photoIds).toEqual(['p1', 'p3']);
      expect(res.primaryPhotoId).toBe('p1');
    });

    it('代表写真の差し替え時に新しい写真が代表を引き継ぐこと', () => {
      const ids = ['p1', 'p2'];
      const res = replacePhotoInDraft(ids, 'p1', 'p-new', 'p1');
      expect(res.photoIds).toEqual(['p-new', 'p2']);
      expect(res.primaryPhotoId).toBe('p-new');
    });
  });

  describe('重複警告と既存銘柄からの流用', () => {
    it('同一銘柄の重複を検出し内訳を正確に集計すること', async () => {
      const b1 = createNewBottle({
        name: '黒龍 しずく',
        category: '日本酒',
        status: 'unopened',
        volumeMl: 720,
      });
      const b2 = createNewBottle({
        name: '黒龍 しずく',
        category: '日本酒',
        status: 'finished',
        volumeMl: 720,
      });
      const b3 = createNewBottle({
        name: '黒龍 しずく',
        category: '日本酒',
        status: 'disposed',
        volumeMl: 720,
      });

      const all = [b1, b2, b3];
      const dup = findDuplicateBottles(all, {
        name: '黒龍 しずく',
        category: '日本酒',
        volumeMl: 720,
      });

      expect(dup.hasDuplicate).toBe(true);
      expect(dup.breakdown.inventory).toBe(1);
      expect(dup.breakdown.finished).toBe(1);
      expect(dup.breakdown.disposed).toBe(1);
      expect(dup.exactMatches).toHaveLength(3);
    });

    it('流用ドラフト生成で状態が未開封にリセットされ購入情報が空になること', () => {
      const sourceBottle: BottleRecord<'ウイスキー'> = {
        id: 'source-bottle-1',
        name: '余市 10年',
        category: 'ウイスキー',
        status: 'finished',
        abv: 45,
        volumeMl: 700,
        openedDate: '2026-01-01',
        finishedDate: '2026-03-01',
        disposedDate: null,
        categoryAttributes: { distillery: '余市蒸留所', ageStatement: '10年' },
        purchaseInfo: {
          purchaseDate: '2025-12-01',
          purchasePlace: '百貨店',
          purchasePriceYen: 12000,
        },
        tastingNote: 'ピート感と果実味のバランスが素晴らしい',
        wantToBuyAgain: true,
        description: {
          summary: 'ニッカウヰスキー余市蒸留所の10年熟成',
          tasteProfile: '力強いピート香とオークの甘み',
          background: '北海道余市町の冷涼な気候で育まれたモルト原酒',
          servingSuggestion: 'ストレートまたはロックがおすすめ',
        },
        sources: [{ url: 'https://example.com/yoichi', title: '公式サイト' }],
        referencePrice: {
          estimatedPriceYen: 15000,
          fetchedDate: '2026-11-09',
        },
        photoIds: ['photo-yoichi-1'],
        primaryPhotoId: 'photo-yoichi-1',
        userEditedFields: ['name'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deleted: false,
      };

      // 写真引き継ぎあり
      const resWithPhoto = createReuseDraftFromBottle(sourceBottle, { copyPhotos: true });
      expect(resWithPhoto.draft.name).toBe('余市 10年');
      expect(resWithPhoto.draft.status).toBe('unopened'); // 未開封にリセット
      expect(resWithPhoto.draft.openedDate).toBeNull();
      expect(resWithPhoto.draft.finishedDate).toBeNull();
      expect(resWithPhoto.draft.purchaseInfo?.purchasePriceYen).toBeNull();
      expect(resWithPhoto.draft.purchaseInfo?.purchasePlace).toBe('');
      expect(resWithPhoto.draft.tastingNote).toBe('');
      expect(resWithPhoto.draft.description?.summary).toBe(sourceBottle.description?.summary);
      expect(resWithPhoto.draft.referencePrice?.estimatedPriceYen).toBe(15000);
      expect(resWithPhoto.photosToClone).toHaveLength(1);
      expect(resWithPhoto.photosToClone[0]?.sourcePhotoId).toBe('photo-yoichi-1');
      expect(resWithPhoto.draft.photoIds).toHaveLength(1);
      expect(resWithPhoto.draft.photoIds?.[0]).not.toBe('photo-yoichi-1'); // 新UUID

      // 写真引き継ぎなし
      const resNoPhoto = createReuseDraftFromBottle(sourceBottle, { copyPhotos: false });
      expect(resNoPhoto.draft.photoIds).toEqual([]);
      expect(resNoPhoto.draft.primaryPhotoId).toBeNull();
      expect(resNoPhoto.photosToClone).toHaveLength(0);
    });
  });

  describe('Gemini JSON 再取り込みと userEditedFields 上書き保護', () => {
    it('手動編集した項目が再取り込みで上書きされず、未編集項目のみ更新されること', () => {
      const currentBottle = {
        name: '手修正した銘柄名',
        category: '日本酒' as const,
        status: 'unopened' as const,
        volumeMl: 720,
        abv: 16.0,
        categoryAttributes: {
          brewery: '手入力の蔵元',
          riceType: '山田錦',
        },
        description: {
          summary: '手修正したひとこと要約',
          tasteProfile: '',
          background: '',
          servingSuggestion: '',
        },
        sources: [],
        referencePrice: null as ReferencePriceInfo | null,
      };

      const payload: GeminiImportPayload = {
        name: 'Geminiが提案した銘柄名',
        category: '日本酒',
        abv: 15.5,
        volumeMl: 720,
        categoryAttributes: {
          brewery: 'Gemini蔵元',
          riceType: '雄町',
        },
        description: {
          summary: 'Geminiが生成した要約',
          tasteProfile: 'Geminiが生成した味わい',
          background: 'Geminiが生成した歴史',
          servingSuggestion: 'Geminiが生成した飲み方',
        },
        sources: [{ url: 'https://example.com/gemini', title: 'Gemini出典' }],
        referencePrice: {
          estimatedPriceYen: 3000,
          fetchedDate: '2026-11-09',
        },
      };

      // ユーザーが手動編集した項目: name, categoryAttributes.brewery, description.summary
      const userEdited = ['name', 'categoryAttributes.brewery', 'description.summary'];
      const result = mergeGeminiPayloadIntoBottle(currentBottle, payload, userEdited);

      // 手動編集項目は保護
      expect(result.merged.name).toBe('手修正した銘柄名');
      expect(result.merged.categoryAttributes.brewery).toBe('手入力の蔵元');
      expect(result.merged.description?.summary).toBe('手修正したひとこと要約');
      expect(result.skippedFields).toContain('name');
      expect(result.skippedFields).toContain('categoryAttributes.brewery');
      expect(result.skippedFields).toContain('description.summary');

      // 手動編集していない項目は Gemini の値で更新
      expect(result.merged.abv).toBe(15.5);
      expect(result.merged.categoryAttributes.riceType).toBe('雄町');
      expect(result.merged.description?.tasteProfile).toBe('Geminiが生成した味わい');
      expect(result.merged.sources).toHaveLength(1);
      expect(result.merged.referencePrice?.estimatedPriceYen).toBe(3000);
    });

    it('手動で空欄にした項目が再取り込みで復活せず、未編集のnull項目はそのままnullになること', () => {
      const currentBottle = {
        name: '手修正した銘柄名',
        category: '日本酒' as const,
        status: 'unopened' as const,
        volumeMl: null, // ユーザーが空欄にした
        abv: null,      // ユーザーが空欄にした
        categoryAttributes: {},
        description: null,
        sources: [],
        referencePrice: {
          estimatedPriceYen: 5000,
          fetchedDate: '2026-11-01',
        },
      };

      const payload: GeminiImportPayload = {
        name: 'Gemini銘柄',
        category: '日本酒',
        abv: 16.0,
        volumeMl: 720,
        categoryAttributes: { brewery: '新蔵元' },
        description: null,
        sources: [],
        referencePrice: null, // 相場目安なし
      };

      // volumeMl と abv を手動で空欄にした
      const userEdited = ['volumeMl', 'abv'];
      const result = mergeGeminiPayloadIntoBottle(currentBottle, payload, userEdited);

      // 手動で空欄にした項目は null のまま保護され、skippedFields に記録される
      expect(result.merged.volumeMl).toBeNull();
      expect(result.merged.abv).toBeNull();
      expect(result.skippedFields).toContain('volumeMl');
      expect(result.skippedFields).toContain('abv');

      // 未編集だった referencePrice は payload の null が反映されて null になる
      expect(result.merged.referencePrice).toBeNull();
      // 未編集の name, categoryAttributes は payload の値で更新される
      expect(result.merged.name).toBe('Gemini銘柄');
      expect((result.merged.categoryAttributes as { brewery?: string }).brewery).toBe('新蔵元');
    });
  });

  describe('複数本一括登録と写真クローン・IndexedDB保存', () => {
    it('3本一括登録で独立したUUIDと写真が正しく保存されること', async () => {
      const srcPhoto = createDummyPhoto('p-upload', 'temp');
      const batch = createBottlesBatch(
        {
          name: 'まとめ買いワイン',
          category: 'ワイン',
          volumeMl: 750,
          abv: 13.5,
          photoIds: [srcPhoto.id],
          primaryPhotoId: srcPhoto.id,
        },
        3
      );

      expect(batch.bottles).toHaveLength(3);
      expect(new Set(batch.bottles.map((b) => b.id)).size).toBe(3);
      expect(batch.photosToClone).toHaveLength(3);

      await saveBottlesBatchWithPhotos(
        batch.bottles,
        [srcPhoto],
        batch.photosToClone
      );

      const savedBottles = await getAllBottles(false);
      expect(savedBottles).toHaveLength(3);

      const savedPhotos = await getAllPhotos(false);
      expect(savedPhotos).toHaveLength(3);

      // 各ボトルの写真IDが相違し、PhotoRecord.bottleId と厳密一致すること
      for (const bottle of savedBottles) {
        expect(bottle.photoIds).toHaveLength(1);
        const pid = bottle.photoIds[0]!;
        const photo = await getPhoto(pid);
        expect(photo).toBeDefined();
        expect(photo?.bottleId).toBe(bottle.id);
      }

      // バックアップ検証
      const backup = await exportBackupData();
      const val = validateBackupData(backup);
      expect(val.success).toBe(true);
    });
  });
});
