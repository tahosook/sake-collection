import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDb,
  closeDb,
  clearDatabase,
  getAllBottles,
  getBottle,
  saveBottle,
  saveBottles,
  deleteBottle,
  getAllPhotos,
  getPhoto,
  getPhotosByBottleId,
  savePhoto,
  savePhotos,
  deletePhoto,
  getMeta,
  setMeta,
  exportBackupData,
  importBackupData,
  loadSampleData,
  saveBottleWithPhotos,
  getPendingDeletedPhotos,
} from '../src/storage/db';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../src/data/sampleData';
import { createNewBottle } from '../src/domain/bottleUtils';
import { validateBackupData } from '../src/domain/validation';
import { BottleRecord, BackupData, PhotoRecord } from '../src/types/sake';

describe('storage (IndexedDB 永続化レイヤー) テスト', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(() => {
    closeDb();
  });

  describe('データベース初期化とメタデータ', () => {
    it('DB接続が正常にオープンし各ストアが存在すること', async () => {
      const db = await getDb();
      expect(db.objectStoreNames.contains('bottles')).toBe(true);
      expect(db.objectStoreNames.contains('photos')).toBe(true);
      expect(db.objectStoreNames.contains('meta')).toBe(true);
    });

    it('ボトルおよび写真ストアに by_deleted インデックスが存在せず適切なインデックスのみ定義されていること', async () => {
      const db = await getDb();
      const tx = db.transaction(['bottles', 'photos'], 'readonly');

      const bottleStore = tx.objectStore('bottles');
      expect(bottleStore.indexNames.contains('by_category')).toBe(true);
      expect(bottleStore.indexNames.contains('by_status')).toBe(true);
      expect(bottleStore.indexNames.contains('by_updatedAt')).toBe(true);
      const bottleIndexes: string[] = Array.from(bottleStore.indexNames);
      expect(bottleIndexes).not.toContain('by_deleted');

      const photoStore = tx.objectStore('photos');
      expect(photoStore.indexNames.contains('by_bottleId')).toBe(true);
      expect(photoStore.indexNames.contains('by_updatedAt')).toBe(true);
      const photoIndexes: string[] = Array.from(photoStore.indexNames);
      expect(photoIndexes).not.toContain('by_deleted');

      await tx.done;
    });

    it('getDb の同時呼び出しで同一の接続インスタンスが共有されること', async () => {
      closeDb(); // 一旦切断して未接続状態にする
      const [db1, db2, db3] = await Promise.all([getDb(), getDb(), getDb()]);
      expect(db1).toBe(db2);
      expect(db2).toBe(db3);
    });

    it('接続開始中に closeDb() を呼び、その完了前に再度 getDb() を呼んでも正常に使える接続が返されること', async () => {
      closeDb(); // 初期状態：未接続
      // 1. 接続開始（await せず接続処理を走らせる）
      const inFlightPromise = getDb();
      // 2. 接続完了前に closeDb() を呼ぶ
      closeDb();
      // 3. 接続完了を待たずに再度 getDb() を呼ぶ
      const activeDbPromise = getDb();

      const [inFlightDb, activeDb] = await Promise.all([inFlightPromise, activeDbPromise]);

      // inFlightDb は close されている
      expect(inFlightDb).toBeDefined();

      // activeDb は正常に開かれた接続であり、操作が成功すること
      expect(activeDb).toBeDefined();
      const bottles = await activeDb.getAll('bottles');
      expect(Array.isArray(bottles)).toBe(true);

      // さらにその後の getDb() も activeDb と同一の有効な接続を返すこと
      const subsequentDb = await getDb();
      expect(subsequentDb).toBe(activeDb);
    });

    it('接続開始中に closeDb() を呼び、初回の接続完了を待ってから再度 getDb() を呼んでも正常に使える接続が返されること', async () => {
      closeDb(); // 初期状態：未接続
      // 1. 接続開始
      const inFlightPromise = getDb();
      // 2. 接続完了前に closeDb()
      closeDb();
      // 3. 初回接続の完了を待機
      await inFlightPromise;

      // 4. 初回完了後に改めて getDb() を呼ぶ
      const activeDb = await getDb();

      // 5. 閉じた接続ではなく、正常に使える接続が返され操作ができること
      expect(activeDb).toBeDefined();
      const count = await activeDb.count('bottles');
      expect(typeof count).toBe('number');
    });

    it('メタデータの保存と取得が動作すること', async () => {
      await setMeta('appName', 'sake-collection');
      const val = await getMeta<string>('appName');
      expect(val).toBe('sake-collection');

      const nonExistent = await getMeta('unknown-key');
      expect(nonExistent).toBeUndefined();
    });
  });

  describe('ボトル CRUD と論理削除', () => {
    it('ボトルの作成・取得・全件取得ができること', async () => {
      const bottle = createNewBottle({
        name: '手入力の純米酒',
        category: '日本酒',
        volumeMl: 720,
      });

      await saveBottle(bottle);

      const fetched = await getBottle(bottle.id);
      expect(fetched).toBeDefined();
      expect(fetched?.name).toBe('手入力の純米酒');
      expect(fetched?.category).toBe('日本酒');
      expect(fetched?.deleted).toBe(false);

      const all = await getAllBottles();
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(bottle.id);
    });

    it('複数ボトルの一括保存ができること', async () => {
      const b1 = createNewBottle({ name: '酒1', category: '日本酒' });
      const b2 = createNewBottle({ name: '酒2', category: 'ワイン' });

      await saveBottles([b1, b2]);

      const all = await getAllBottles();
      expect(all).toHaveLength(2);
    });

    it('論理削除により deleted=true となり、通常の getAllBottles から除外されること', async () => {
      const bottle = createNewBottle({ name: '削除テスト酒', category: '焼酎' });
      await saveBottle(bottle);

      const deleteTime = '2026-11-08T23:00:00.000Z';
      await deleteBottle(bottle.id, deleteTime);

      // 通常取得では除外
      const activeBottles = await getAllBottles(false);
      expect(activeBottles.some((b) => b.id === bottle.id)).toBe(false);

      // includeDeleted: true では取得可能
      const allBottles = await getAllBottles(true);
      const deletedOne = allBottles.find((b) => b.id === bottle.id);
      expect(deletedOne).toBeDefined();
      expect(deletedOne?.deleted).toBe(true);
      expect(deletedOne?.updatedAt).toBe(deleteTime);
    });
  });

  describe('写真 CRUD', () => {
    it('写真の保存と取得、bottleId による検索ができること', async () => {
      const bottleId = '00000000-0001-4000-8000-000000000001';
      const samplePhoto = SAMPLE_PHOTOS[0]!;

      await savePhoto(samplePhoto);

      const fetched = await getPhoto(samplePhoto.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(samplePhoto.id);
      expect(fetched?.bottleId).toBe(bottleId);

      const byBottle = await getPhotosByBottleId(bottleId);
      expect(byBottle).toHaveLength(1);
      expect(byBottle[0]?.id).toBe(samplePhoto.id);

      const emptyBottlePhotos = await getPhotosByBottleId('non-existent-bottle');
      expect(emptyBottlePhotos).toHaveLength(0);
    });

    it('写真の一括保存と論理削除ができること', async () => {
      await savePhotos(SAMPLE_PHOTOS);

      const all = await getAllPhotos(false);
      expect(all).toHaveLength(SAMPLE_PHOTOS.length);

      const targetPhoto = SAMPLE_PHOTOS[0]!;
      await deletePhoto(targetPhoto.id);

      const activePhotos = await getAllPhotos(false);
      expect(activePhotos).toHaveLength(SAMPLE_PHOTOS.length - 1);
      expect(activePhotos.some((p) => p.id === targetPhoto.id)).toBe(false);

      const allPhotos = await getAllPhotos(true);
      expect(allPhotos).toHaveLength(SAMPLE_PHOTOS.length);
    });
  });

  describe('サンプルデータの読み込み', () => {
    it('loadSampleData によりサンプルデータ全件が IndexedDB に投入されること', async () => {
      const count = await loadSampleData();
      expect(count.bottles).toBe(SAMPLE_BOTTLES.length);
      expect(count.photos).toBe(SAMPLE_PHOTOS.length);

      const bottles = await getAllBottles(true);
      const photos = await getAllPhotos(true);

      expect(bottles).toHaveLength(SAMPLE_BOTTLES.length);
      expect(photos).toHaveLength(SAMPLE_PHOTOS.length);

      const metaLoaded = await getMeta('isSampleDataLoaded');
      expect(metaLoaded).toBe(true);
    });
  });

  describe('バックアップの書き出しと読み込み (往復の整合性)', () => {
    it('バックアップ書き出しにより論理削除済みも含むデータが出力され、削除ボトルの写真参照が正規化されること', async () => {
      await loadSampleData();

      // 1件論理削除（SAMPLE_BOTTLES[0] には写真が2枚紐づいている）
      const targetBottle = SAMPLE_BOTTLES[0]!;
      await deleteBottle(targetBottle.id);

      const backup = await exportBackupData();
      expect(backup.schemaVersion).toBe(1);
      expect(backup.exportedAt).toBeDefined();
      expect(backup.bottles).toHaveLength(SAMPLE_BOTTLES.length);
      // 削除されたボトルの写真は物理削除されるため、残りの有効な写真のみが出力される
      expect(backup.photos).toHaveLength(SAMPLE_PHOTOS.length - 2);

      // 論理削除されたボトルも含まれており、photoIds: [] と primaryPhotoId: null に正規化されていること
      const deletedInBackup = backup.bottles.find((b) => b.id === targetBottle.id);
      expect(deletedInBackup?.deleted).toBe(true);
      expect(deletedInBackup?.photoIds).toEqual([]);
      expect(deletedInBackup?.primaryPhotoId).toBeNull();

      // 直後のバックアップ検証が厳格に成功すること
      const valRes = validateBackupData(backup);
      expect(valRes.success).toBe(true);

      const lastBackupAt = await getMeta('lastBackupAt');
      expect(lastBackupAt).toBe(backup.exportedAt);
    });

    it('同期前（削除直後）のストレージ検証: 未同期写真は物理削除のみ、同期済み写真は pendingDeletedPhotos に退避されること', async () => {
      // 1. 未同期写真を持つボトル
      const unsyncedPhotoId = '22222222-0001-4000-8000-000000000001';
      const bottle1 = createNewBottle({ name: '未同期写真酒', category: '日本酒', photoIds: [unsyncedPhotoId] });
      const photo1: PhotoRecord = {
        id: unsyncedPhotoId,
        bottleId: bottle1.id,
        mimeType: 'image/jpeg',
        dataUrl: SAMPLE_PHOTOS[0]!.dataUrl,
        width: 400,
        height: 500,
        byteSize: 144,
        contentHash: 'hash-unsynced-1',
        driveFileId: null, // 未同期
        createdAt: '2026-11-10T10:00:00.000Z',
        updatedAt: '2026-11-10T10:00:00.000Z',
        deleted: false,
      };
      await saveBottleWithPhotos(bottle1, [photo1]);

      // 2. 同期済み写真を持つボトル
      const syncedPhotoId = '22222222-0002-4000-8000-000000000002';
      const bottle2 = createNewBottle({ name: '同期済み写真酒', category: '日本酒', photoIds: [syncedPhotoId] });
      const photo2: PhotoRecord = {
        id: syncedPhotoId,
        bottleId: bottle2.id,
        mimeType: 'image/jpeg',
        dataUrl: SAMPLE_PHOTOS[1]!.dataUrl,
        width: 400,
        height: 500,
        byteSize: 144,
        contentHash: 'hash-synced-2',
        driveFileId: 'drive-file-id-abc', // 同期済み
        createdAt: '2026-11-10T10:00:00.000Z',
        updatedAt: '2026-11-10T10:00:00.000Z',
        deleted: false,
      };
      await saveBottleWithPhotos(bottle2, [photo2]);

      // bottle1 (未同期) を削除
      await deleteBottle(bottle1.id);
      expect((await getBottle(bottle1.id))?.deleted).toBe(true);
      expect((await getBottle(bottle1.id))?.photoIds).toEqual([]);
      expect(await getPhoto(unsyncedPhotoId)).toBeUndefined();
      // 未同期写真は pendingDeletedPhotos に残らない
      const pendingAfterB1 = await getPendingDeletedPhotos();
      expect(pendingAfterB1).toHaveLength(0);

      // bottle2 (同期済み) を削除
      await deleteBottle(bottle2.id);
      expect((await getBottle(bottle2.id))?.deleted).toBe(true);
      expect((await getBottle(bottle2.id))?.photoIds).toEqual([]);
      expect(await getPhoto(syncedPhotoId)).toBeUndefined();
      // 同期済み写真は pendingDeletedPhotos に記録される
      const pendingAfterB2 = await getPendingDeletedPhotos();
      expect(pendingAfterB2).toHaveLength(1);
      expect(pendingAfterB2[0]?.id).toBe(syncedPhotoId);
      expect(pendingAfterB2[0]?.deleted).toBe(true);

      // 削除直後にバックアップを書き出して検証
      const backup = await exportBackupData();
      const valRes = validateBackupData(backup);
      expect(valRes.success).toBe(true);
    });

    it('正常なバックアップデータを完全に復元できること（往復整合性）', async () => {
      // 1. サンプルデータをロードしてエクスポート
      await loadSampleData();
      const exportedBackup = await exportBackupData();

      // 2. データベースをクリア
      await clearDatabase();
      expect(await getAllBottles(true)).toHaveLength(0);
      expect(await getAllPhotos(true)).toHaveLength(0);

      // 3. インポート実行
      const importResult = await importBackupData(exportedBackup);
      expect(importResult.success).toBe(true);
      if (importResult.success) {
        expect(importResult.count.bottles).toBe(SAMPLE_BOTTLES.length);
        expect(importResult.count.photos).toBe(SAMPLE_PHOTOS.length);
      }

      // 4. 復元後のデータ検証
      const restoredBottles = await getAllBottles(true);
      const restoredPhotos = await getAllPhotos(true);
      expect(restoredBottles).toHaveLength(SAMPLE_BOTTLES.length);
      expect(restoredPhotos).toHaveLength(SAMPLE_PHOTOS.length);

      // JSON 文字列形式でもインポートできること
      const jsonStr = JSON.stringify(exportedBackup);
      const strImportResult = await importBackupData(jsonStr);
      expect(strImportResult.success).toBe(true);
    });

    it('不正なバックアップ読み込み時にアトミックに拒否され既存データが保護されること', async () => {
      // 1. 最初にある正常なデータを投入
      const initialBottle = createNewBottle({
        name: '保護されるべき初期データ',
        category: '日本酒',
      });
      await saveBottle(initialBottle);

      // 2. 破損したバックアップデータを用意（未開封なのに開封日が入っている不正データ）
      const corruptedBackup: BackupData = {
        schemaVersion: 1,
        exportedAt: '2026-11-08T12:00:00.000Z',
        bottles: [
          {
            ...SAMPLE_BOTTLES[0]!,
            status: 'unopened',
            openedDate: '2026-10-01', // 不正
          } as BottleRecord,
        ],
        photos: [],
      };

      // 3. インポート試行 -> 失敗すること
      const result = await importBackupData(corruptedBackup);
      expect(result.success).toBe(false);

      // 4. アトミック性の確認: 既存データがクリアされたり書き換わったりしていないこと
      const remainingBottles = await getAllBottles(true);
      expect(remainingBottles).toHaveLength(1);
      expect(remainingBottles[0]?.id).toBe(initialBottle.id);
      expect(remainingBottles[0]?.name).toBe('保護されるべき初期データ');
    });

    it('壊れた JSON 文字列を渡したときにエラーになり既存データが保護されること', async () => {
      const initialBottle = createNewBottle({ name: '初期酒', category: 'ビール' });
      await saveBottle(initialBottle);

      const result = await importBackupData('{ invalid json format');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('JSON形式が正しくありません');
      }

      // 既存データの保護
      const remaining = await getAllBottles(true);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(initialBottle.id);
    });
  });
});
