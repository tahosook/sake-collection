import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  calculateResizedDimensions,
  computeDataUrlHashAndSize,
  resolveEffectivePrimaryPhotoId,
  addPhotoToDraft,
  removePhotoFromDraft,
  replacePhotoInDraft,
  MAX_PHOTO_COUNT,
} from '../src/domain/photoUtils';
import {
  closeDb,
  clearDatabase,
  saveBottleWithPhotos,
  saveBottlesBatchWithPhotos,
  deleteBottle,
  getBottle,
  getPhoto,
  getPhotosByBottleId,
  getAllBottles,
  getAllPhotos,
  exportBackupData,
} from '../src/storage/db';
import { validateBackupData } from '../src/domain/validation';
import { createNewBottle, createBottlesBatch, createReuseDraftFromBottle } from '../src/domain/bottleUtils';
import { BottleRecord, PhotoRecord } from '../src/types/sake';
import { SAMPLE_PHOTOS } from '../src/data/sampleData';

describe('写真処理と保存トランザクション (PR #7)', () => {
  describe('calculateResizedDimensions (リサイズ寸法計算)', () => {
    it('長辺が1600px以下の場合は拡大せず元の寸法を維持すること', () => {
      expect(calculateResizedDimensions(800, 600)).toEqual({ width: 800, height: 600 });
      expect(calculateResizedDimensions(1200, 1600)).toEqual({ width: 1200, height: 1600 });
      expect(calculateResizedDimensions(1600, 1200)).toEqual({ width: 1600, height: 1200 });
    });

    it('長辺が1600pxを超える場合は長辺が1600pxに縮小されアスペクト比が維持されること', () => {
      // 横長: 3200x2400 (4:3) -> 1600x1200
      expect(calculateResizedDimensions(3200, 2400)).toEqual({ width: 1600, height: 1200 });

      // 縦長: 2000x4000 (1:2) -> 800x1600
      expect(calculateResizedDimensions(2000, 4000)).toEqual({ width: 800, height: 1600 });

      // 正方形: 2400x2400 -> 1600x1600
      expect(calculateResizedDimensions(2400, 2400)).toEqual({ width: 1600, height: 1600 });
    });

    it('端数が適切に四捨五入されること', () => {
      // 1920 x 1080 -> 1600 x (1080 * 1600 / 1920 = 900)
      expect(calculateResizedDimensions(1920, 1080)).toEqual({ width: 1600, height: 900 });
    });
  });

  describe('computeDataUrlHashAndSize (SHA-256 ハッシュとサイズ算出)', () => {
    it('サンプル写真の Base64 Data URL から正確な SHA-256 ハッシュとバイトサイズが計算できること', async () => {
      const samplePhoto = SAMPLE_PHOTOS[0]!;
      const result = await computeDataUrlHashAndSize(samplePhoto.dataUrl);

      expect(result.contentHash).toBe(samplePhoto.contentHash);
      expect(result.byteSize).toBe(samplePhoto.byteSize);
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('カンマが含まれない不正な Data URL の場合はエラーを投げること', async () => {
      await expect(computeDataUrlHashAndSize('invalid-data-url')).rejects.toThrow(
        '不正な Data URL です'
      );
    });
  });

  describe('ドラフト写真リストと代表写真の操作純粋関数', () => {
    const p1 = 'photo-111';
    const p2 = 'photo-222';
    const p3 = 'photo-333';

    describe('resolveEffectivePrimaryPhotoId', () => {
      it('写真配列が空なら null を返すこと', () => {
        expect(resolveEffectivePrimaryPhotoId([])).toBeNull();
      });

      it('指定された代表写真が配列に含まれていればそれを返すこと', () => {
        expect(resolveEffectivePrimaryPhotoId([p1, p2], p2)).toBe(p2);
      });

      it('指定された代表写真が配列外（削除等）なら先頭を返すこと', () => {
        expect(resolveEffectivePrimaryPhotoId([p1, p2], 'deleted-photo')).toBe(p1);
      });
    });

    describe('addPhotoToDraft', () => {
      it('1枚目の追加で自動的に代表写真になること', () => {
        const res = addPhotoToDraft([], p1);
        expect(res.photoIds).toEqual([p1]);
        expect(res.primaryPhotoId).toBe(p1);
      });

      it('2枚目以降の追加では既存の代表写真が維持されること', () => {
        const res = addPhotoToDraft([p1], p2, p1);
        expect(res.photoIds).toEqual([p1, p2]);
        expect(res.primaryPhotoId).toBe(p1);
      });

      it('上限枚数（10枚）に達した場合はエラーをスローすること', () => {
        const fullList = Array.from({ length: MAX_PHOTO_COUNT }, (_, i) => `photo-${i}`);
        expect(() => addPhotoToDraft(fullList, 'photo-overflow', fullList[0])).toThrow(
          `写真は1本につき最大 ${MAX_PHOTO_COUNT} 枚までです。`
        );
      });
    });

    describe('removePhotoFromDraft', () => {
      it('代表写真以外の削除では代表写真が維持されること', () => {
        const res = removePhotoFromDraft([p1, p2, p3], p2, p1);
        expect(res.photoIds).toEqual([p1, p3]);
        expect(res.primaryPhotoId).toBe(p1);
      });

      it('代表写真を削除した場合は残る先頭が自動昇格すること', () => {
        const res = removePhotoFromDraft([p1, p2, p3], p1, p1);
        expect(res.photoIds).toEqual([p2, p3]);
        expect(res.primaryPhotoId).toBe(p2);
      });

      it('最後の1枚を削除した場合は primaryPhotoId が null になること', () => {
        const res = removePhotoFromDraft([p1], p1, p1);
        expect(res.photoIds).toEqual([]);
        expect(res.primaryPhotoId).toBeNull();
      });
    });

    describe('replacePhotoInDraft', () => {
      it('指定された写真IDが差し替えられ、代表写真の差し替えなら新しい写真が代表になること', () => {
        const newPhoto = 'photo-replaced';
        const res = replacePhotoInDraft([p1, p2], p1, newPhoto, p1);
        expect(res.photoIds).toEqual([newPhoto, p2]);
        expect(res.primaryPhotoId).toBe(newPhoto);
      });

      it('代表写真以外の差し替えでは既存の代表写真が維持されること', () => {
        const newPhoto = 'photo-replaced';
        const res = replacePhotoInDraft([p1, p2], p2, newPhoto, p1);
        expect(res.photoIds).toEqual([p1, newPhoto]);
        expect(res.primaryPhotoId).toBe(p1);
      });
    });
  });

  describe('IndexedDB トランザクション処理 (saveBottleWithPhotos / saveBottlesBatchWithPhotos / deleteBottle)', () => {
    beforeEach(async () => {
      await clearDatabase();
    });

    afterEach(() => {
      closeDb();
    });

    const createDummyPhoto = (photoId: string, bottleId: string): PhotoRecord => {
      return {
        id: photoId,
        bottleId,
        mimeType: 'image/jpeg',
        dataUrl: SAMPLE_PHOTOS[0]!.dataUrl,
        width: 400,
        height: 500,
        byteSize: SAMPLE_PHOTOS[0]!.byteSize,
        contentHash: SAMPLE_PHOTOS[0]!.contentHash,
        driveFileId: null,
        createdAt: '2026-11-09T10:00:00.000Z',
        updatedAt: '2026-11-09T10:00:00.000Z',
        deleted: false,
      };
    };

    it('saveBottleWithPhotos: ボトルと新規写真が単一トランザクションで保存されること', async () => {
      const bottleId = crypto.randomUUID();
      const photoId1 = crypto.randomUUID();
      const photoId2 = crypto.randomUUID();

      const bottle = createNewBottle({
        name: '写真付きテスト酒',
        category: '日本酒',
        photoIds: [photoId1, photoId2],
        primaryPhotoId: photoId1,
      }, { id: bottleId });

      const photo1 = createDummyPhoto(photoId1, bottleId);
      const photo2 = createDummyPhoto(photoId2, bottleId);

      await saveBottleWithPhotos(bottle, [photo1, photo2]);

      const loadedBottle = await getBottle(bottleId);
      expect(loadedBottle).toBeDefined();
      expect(loadedBottle?.photoIds).toEqual([photoId1, photoId2]);
      expect(loadedBottle?.primaryPhotoId).toBe(photoId1);

      const loadedPhotos = await getPhotosByBottleId(bottleId);
      expect(loadedPhotos).toHaveLength(2);
      expect(loadedPhotos.map((p) => p.id).sort()).toEqual([photoId1, photoId2].sort());

      // バックアップ検証が通ること
      const backup = await exportBackupData();
      const backupVal = validateBackupData(backup);
      expect(backupVal.success).toBe(true);
    });

    it('saveBottleWithPhotos: ボトル更新で photoIds から外された未同期写真が物理削除されること', async () => {
      const bottleId = crypto.randomUUID();
      const photoId1 = crypto.randomUUID();
      const photoId2 = crypto.randomUUID();

      const bottle = createNewBottle({
        name: '更新前ボトル',
        category: 'ウイスキー',
        photoIds: [photoId1, photoId2],
        primaryPhotoId: photoId1,
      }, { id: bottleId });

      await saveBottleWithPhotos(bottle, [
        createDummyPhoto(photoId1, bottleId),
        createDummyPhoto(photoId2, bottleId),
      ]);

      expect(await getPhotosByBottleId(bottleId)).toHaveLength(2);

      // photoId2 を削除して photoId3 を追加する更新
      const photoId3 = crypto.randomUUID();
      const updatedBottle: BottleRecord = {
        ...bottle,
        photoIds: [photoId1, photoId3],
        primaryPhotoId: photoId1,
        updatedAt: '2026-11-09T11:00:00.000Z',
      };
      const photo3 = createDummyPhoto(photoId3, bottleId);

      await saveBottleWithPhotos(updatedBottle, [photo3]);

      // photoId2 は削除され、photoId1 と photoId3 のみが残ること
      const currentPhotos = await getPhotosByBottleId(bottleId);
      expect(currentPhotos).toHaveLength(2);
      expect(currentPhotos.map((p) => p.id).sort()).toEqual([photoId1, photoId3].sort());

      const deletedPhoto = await getPhoto(photoId2);
      expect(deletedPhoto).toBeUndefined(); // 物理削除されている

      // バックアップ検証が整合していること（外された写真が残っていると parentBottle.photoIds に含まれず失敗する）
      const backup = await exportBackupData();
      const backupVal = validateBackupData(backup);
      expect(backupVal.success).toBe(true);
    });

    it('saveBottlesBatchWithPhotos: 複数本一括登録で独立した PhotoRecord がクローン保存されること', async () => {
      // 1. 元のボトルと写真を用意
      const originalBottleId = crypto.randomUUID();
      const originalPhotoId = crypto.randomUUID();
      const originalBottle = createNewBottle({
        name: '山崎 18年',
        category: 'ウイスキー',
        photoIds: [originalPhotoId],
        primaryPhotoId: originalPhotoId,
      }, { id: originalBottleId });
      const originalPhoto = createDummyPhoto(originalPhotoId, originalBottleId);
      await saveBottleWithPhotos(originalBottle, [originalPhoto]);

      // 2. createBottlesBatch で2本生成
      const batchResult = createBottlesBatch({
        name: '山崎 18年',
        category: 'ウイスキー',
        photoIds: [originalPhotoId],
        primaryPhotoId: originalPhotoId,
      }, 2);

      expect(batchResult.bottles).toHaveLength(2);
      expect(batchResult.photosToClone).toHaveLength(2);

      // 3. 一括保存
      await saveBottlesBatchWithPhotos(
        batchResult.bottles,
        [],
        batchResult.photosToClone
      );

      // 全ボトル件数: 元の1本 + バッチ2本 = 3本
      const allBottles = await getAllBottles();
      expect(allBottles).toHaveLength(3);

      // 全写真件数: 元の1枚 + クローン2枚 = 3枚
      const allPhotos = await getAllPhotos();
      expect(allPhotos).toHaveLength(3);

      // クローンされた写真はそれぞれ独立した UUID と正しい bottleId を持っていること
      for (const b of batchResult.bottles) {
        const bottlePhotos = await getPhotosByBottleId(b.id);
        expect(bottlePhotos).toHaveLength(1);
        expect(bottlePhotos[0]?.id).toBe(b.photoIds[0]);
        expect(bottlePhotos[0]?.bottleId).toBe(b.id);
        expect(bottlePhotos[0]?.dataUrl).toBe(originalPhoto.dataUrl);
        expect(bottlePhotos[0]?.contentHash).toBe(originalPhoto.contentHash);
      }

      // バックアップ整合性
      const backup = await exportBackupData();
      const backupVal = validateBackupData(backup);
      expect(backupVal.success).toBe(true);
    });

    it('saveBottlesBatchWithPhotos: クローン元の写真が存在しない場合はエラーを投げ、ボトル保存も中断されること', async () => {
      const missingSourcePhotoId = crypto.randomUUID();
      const newBottleId = crypto.randomUUID();
      const newPhotoId = crypto.randomUUID();

      const bottle = createNewBottle({
        name: 'クローン失敗テスト酒',
        category: '焼酎',
        photoIds: [newPhotoId],
        primaryPhotoId: newPhotoId,
      }, { id: newBottleId });

      await expect(
        saveBottlesBatchWithPhotos(
          [bottle],
          [],
          [{ sourcePhotoId: missingSourcePhotoId, newPhotoId, bottleId: newBottleId }]
        )
      ).rejects.toThrow('クローン元の写真レコードが見つかりません');

      // トランザクションが中断され、ボトルも写真も保存されていないこと
      expect(await getBottle(newBottleId)).toBeUndefined();
      expect(await getPhoto(newPhotoId)).toBeUndefined();
    });

    it('createReuseDraftFromBottle と saveBottlesBatchWithPhotos の連携による流用保存', async () => {
      // 1. 流用元ボトルを保存
      const sourceBottleId = crypto.randomUUID();
      const sourcePhotoId = crypto.randomUUID();
      const sourceBottle = createNewBottle({
        name: '獺祭 23',
        category: '日本酒',
        photoIds: [sourcePhotoId],
        primaryPhotoId: sourcePhotoId,
      }, { id: sourceBottleId });
      await saveBottleWithPhotos(sourceBottle, [createDummyPhoto(sourcePhotoId, sourceBottleId)]);

      // 2. 流用ドラフトを生成
      const { draft, photosToClone } = createReuseDraftFromBottle(sourceBottle, { copyPhotos: true });
      expect(photosToClone).toHaveLength(1);
      expect(photosToClone[0]?.sourcePhotoId).toBe(sourcePhotoId);
      const newPhotoId = photosToClone[0]?.newPhotoId;

      // 3. 流用先ボトルを新規保存
      const newBottleId = crypto.randomUUID();
      const newBottle = createNewBottle(draft, { id: newBottleId });

      await saveBottlesBatchWithPhotos(
        [newBottle],
        [],
        photosToClone.map((ptc) => ({ ...ptc, bottleId: newBottleId }))
      );

      // 流用先ボトルと写真の確認
      const loadedNewBottle = await getBottle(newBottleId);
      expect(loadedNewBottle?.photoIds).toEqual([newPhotoId]);

      const loadedNewPhoto = await getPhoto(newPhotoId!);
      expect(loadedNewPhoto).toBeDefined();
      expect(loadedNewPhoto?.bottleId).toBe(newBottleId);

      // バックアップ整合性
      const backup = await exportBackupData();
      const backupVal = validateBackupData(backup);
      expect(backupVal.success).toBe(true);
    });

    it('deleteBottle: ボトル論理削除時に紐づく写真も同一トランザクションで論理削除されること', async () => {
      const bottleId = crypto.randomUUID();
      const photoId1 = crypto.randomUUID();
      const photoId2 = crypto.randomUUID();

      const bottle = createNewBottle({
        name: '削除テスト酒',
        category: 'ジン',
        photoIds: [photoId1, photoId2],
        primaryPhotoId: photoId1,
      }, { id: bottleId });

      await saveBottleWithPhotos(bottle, [
        createDummyPhoto(photoId1, bottleId),
        createDummyPhoto(photoId2, bottleId),
      ]);

      expect((await getAllBottles()).length).toBe(1);
      expect((await getAllPhotos()).length).toBe(2);

      // 論理削除実行
      const deleteTime = '2026-11-09T12:00:00.000Z';
      await deleteBottle(bottleId, deleteTime);

      // 有効一覧からは除外される
      expect(await getAllBottles(false)).toHaveLength(0);
      expect(await getAllPhotos(false)).toHaveLength(0);

      // includeDeleted: true で確認
      const deletedBottle = await getBottle(bottleId);
      expect(deletedBottle?.deleted).toBe(true);
      expect(deletedBottle?.updatedAt).toBe(deleteTime);
      expect(deletedBottle?.photoIds).toEqual([photoId1, photoId2]); // photoIds は維持

      const p1 = await getPhoto(photoId1);
      const p2 = await getPhoto(photoId2);
      expect(p1?.deleted).toBe(true);
      expect(p1?.updatedAt).toBe(deleteTime);
      expect(p2?.deleted).toBe(true);
      expect(p2?.updatedAt).toBe(deleteTime);

      // バックアップ整合性（論理削除済み同士でも photo.bottleId === bottle.id が保たれている）
      const backup = await exportBackupData();
      const backupVal = validateBackupData(backup);
      expect(backupVal.success).toBe(true);
    });
  });
});
