import { openDB, DBSchema, IDBPDatabase } from 'idb';
import {
  BottleRecord,
  PhotoRecord,
  PhotoSyncMeta,
  SyncConnectionConfig,
  BackupData,
  SakeCategory,
  BottleStatus,
} from '../types/sake';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../data/sampleData';
import { validateBackupData } from '../domain/validation';
import { toPhotoSyncMeta } from '../domain/syncMerge';

export const DB_NAME = 'sake-collection-db';
export const DB_VERSION = 1;

/**
 * IndexedDB のメタデータストア用レコード型
 */
export interface MetaRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: string;
}

/**
 * sake-collection IndexedDB スキーマ定義
 */
export interface SakeCollectionDBSchema extends DBSchema {
  bottles: {
    key: string; // id (UUID)
    value: BottleRecord;
    indexes: {
      by_category: SakeCategory;
      by_status: BottleStatus;
      by_updatedAt: string;
    };
  };
  photos: {
    key: string; // id (UUID)
    value: PhotoRecord;
    indexes: {
      by_bottleId: string;
      by_updatedAt: string;
    };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
}

let dbInstance: IDBPDatabase<SakeCollectionDBSchema> | null = null;
let dbPromise: Promise<IDBPDatabase<SakeCollectionDBSchema>> | null = null;
let connectionGeneration = 0;

/**
 * IndexedDB 接続を開く（シングルトン接続）
 * 同時呼び出し時は接続開始中の Promise を共有する
 */
export async function getDb(): Promise<IDBPDatabase<SakeCollectionDBSchema>> {
  if (dbInstance) {
    return dbInstance;
  }

  if (!dbPromise) {
    const currentGeneration = ++connectionGeneration;
    dbPromise = (async () => {
      try {
        const db = await openDB<SakeCollectionDBSchema>(DB_NAME, DB_VERSION, {
          upgrade(db) {
            // 1. bottles ストア
            if (!db.objectStoreNames.contains('bottles')) {
              const bottleStore = db.createObjectStore('bottles', { keyPath: 'id' });
              bottleStore.createIndex('by_category', 'category');
              bottleStore.createIndex('by_status', 'status');
              bottleStore.createIndex('by_updatedAt', 'updatedAt');
            }

            // 2. photos ストア
            if (!db.objectStoreNames.contains('photos')) {
              const photoStore = db.createObjectStore('photos', { keyPath: 'id' });
              photoStore.createIndex('by_bottleId', 'bottleId');
              photoStore.createIndex('by_updatedAt', 'updatedAt');
            }

            // 3. meta ストア
            if (!db.objectStoreNames.contains('meta')) {
              db.createObjectStore('meta', { keyPath: 'key' });
            }
          },
        });

        // 接続完了時点で、この接続の世代が最新であるか確認
        if (connectionGeneration === currentGeneration) {
          dbInstance = db;
        } else {
          // 接続開始中に closeDb() が呼ばれていた場合:
          // dbInstance には格納せず、開かれた接続を即座に閉じる
          db.close();
        }

        return db;
      } catch (err) {
        if (connectionGeneration === currentGeneration) {
          dbPromise = null;
        }
        throw err;
      }
    })();
  }

  return dbPromise;
}

/**
 * テスト用・リセット用：DB接続を閉じてシングルトンおよび保持した Promise を破棄
 */
export function closeDb(): void {
  connectionGeneration++;
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  if (dbPromise) {
    const pending = dbPromise;
    dbPromise = null;
    void pending
      .then((db) => {
        try {
          db.close();
        } catch {
          // すでにクローズ済みの場合は無視
        }
        if (dbInstance === db) {
          dbInstance = null;
        }
      })
      .catch(() => {
        // 接続開始時の例外は無視
      });
  }
}

// ==========================================
// ボトル操作 (Bottles CRUD)
// ==========================================

/**
 * 全ボトルを取得する（既定では論理削除済みを除外）
 */
export async function getAllBottles(includeDeleted: boolean = false): Promise<BottleRecord[]> {
  const db = await getDb();
  const all = await db.getAll('bottles');
  if (includeDeleted) {
    return all;
  }
  return all.filter((b) => !b.deleted);
}

/**
 * ID で単一ボトルを取得する
 */
export async function getBottle(id: string): Promise<BottleRecord | undefined> {
  const db = await getDb();
  return db.get('bottles', id);
}

/**
 * ボトルを保存（新規登録または更新）する
 */
export async function saveBottle(bottle: BottleRecord): Promise<void> {
  const db = await getDb();
  await db.put('bottles', bottle);
}

/**
 * 複数ボトルを一括保存する
 */
export async function saveBottles(bottles: BottleRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('bottles', 'readwrite');
  for (const bottle of bottles) {
    await tx.store.put(bottle);
  }
  await tx.done;
}

/**
 * ボトルを論理削除する（deleted = true, updatedAt = now）
 * 紐づく写真レコードも同一トランザクションで論理削除する（設計 §3.3 準拠）
 */
export async function deleteBottle(id: string, nowIso: string = new Date().toISOString()): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos'], 'readwrite');
  const bottleStore = tx.objectStore('bottles');
  const photoStore = tx.objectStore('photos');

  const bottle = await bottleStore.get(id);
  if (bottle) {
    bottle.deleted = true;
    bottle.updatedAt = nowIso;
    await bottleStore.put(bottle);

    // 紐づく写真もすべて論理削除
    const relatedPhotos = await photoStore.index('by_bottleId').getAll(id);
    for (const p of relatedPhotos) {
      p.deleted = true;
      p.updatedAt = nowIso;
      await photoStore.put(p);
    }
  }

  await tx.done;
}

/**
 * ボトルと関連写真を単一トランザクションで保存する
 *
 * 要件（設計 docs/step3-4-design.md §3(2) 確定仕様）:
 * - ボトルレコードを保存
 * - newPhotos に渡された新規・更新写真を保存
 * - ボトルの photoIds から外された写真について:
 *   - driveFileId !== null（Drive 同期済み）だった場合は、同一トランザクション内で
 *     meta ストアの 'pendingDeletedPhotos' に削除予定メタデータ（deleted = true）を記録
 *   - driveFileId の有無にかかわらず、ローカルの photos ストアからは即座に物理削除する
 *   - これにより、直後にバックアップ JSON を書き出しても parentBottle.photoIds に含まれない
 *     孤立写真が photos ストアに残る不整合（validateBackupData 失敗）を完全に防止する
 */
export async function saveBottleWithPhotos(
  bottle: BottleRecord,
  newPhotos: PhotoRecord[] = []
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  const bottleStore = tx.objectStore('bottles');
  const photoStore = tx.objectStore('photos');
  const metaStore = tx.objectStore('meta');

  // 1. ボトル保存
  await bottleStore.put(bottle);

  // 2. 新規写真保存
  for (const photo of newPhotos) {
    await photoStore.put(photo);
  }

  // 3. このボトルに現在紐づく写真のうち、photoIds から外れた写真を処理
  const existingPhotos = await photoStore.index('by_bottleId').getAll(bottle.id);
  const activePhotoIdSet = new Set(bottle.photoIds);
  const removedPhotos = existingPhotos.filter((p) => !activePhotoIdSet.has(p.id));

  if (removedPhotos.length > 0) {
    const removedSyncedMetas: PhotoSyncMeta[] = [];

    for (const p of removedPhotos) {
      if (p.driveFileId !== null) {
        const meta = toPhotoSyncMeta(p);
        removedSyncedMetas.push({
          ...meta,
          deleted: true,
          updatedAt: bottle.updatedAt,
        });
      }
      // ローカル photos ストアからは即座に物理削除
      await photoStore.delete(p.id);
    }

    // Drive 同期済みだった写真があれば pendingDeletedPhotos に追記
    if (removedSyncedMetas.length > 0) {
      const existingMetaRecord = await metaStore.get('pendingDeletedPhotos');
      const currentPending = Array.isArray(existingMetaRecord?.value)
        ? (existingMetaRecord.value as PhotoSyncMeta[])
        : [];

      const pendingMap = new Map<string, PhotoSyncMeta>(currentPending.map((m) => [m.id, m]));
      for (const m of removedSyncedMetas) {
        pendingMap.set(m.id, m);
      }

      await metaStore.put({
        key: 'pendingDeletedPhotos',
        value: Array.from(pendingMap.values()),
        updatedAt: bottle.updatedAt,
      });
    }
  }

  await tx.done;
}

/**
 * 写真のクローン指定インターフェース
 */
export interface PhotoCloneInstruction {
  sourcePhotoId: string;
  newPhotoId: string;
  bottleId?: string;
}

/**
 * 複数ボトルと写真を単一トランザクションで一括保存する
 *
 * 要件:
 * - 複数本一括登録（createBottlesBatch）および既存銘柄流用時の写真複製に対応
 * - クローン元の写真レコードから画像データ（dataUrl, contentHash 等）を引き継ぎ、
 *   新しい PhotoRecord（新UUID・各ボトルのbottleId）を生成して保存する
 */
export async function saveBottlesBatchWithPhotos(
  bottles: BottleRecord[],
  newPhotos: PhotoRecord[] = [],
  photosToClone: PhotoCloneInstruction[] = [],
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos'], 'readwrite');
  const bottleStore = tx.objectStore('bottles');
  const photoStore = tx.objectStore('photos');

  try {
    // 1. クローン対象の写真の検証とオブジェクト生成
    const clonedPhotos: PhotoRecord[] = [];
    if (photosToClone.length > 0) {
      const sourcePhotoCache = new Map<string, PhotoRecord | undefined>();

      for (const ptc of photosToClone) {
        let src = sourcePhotoCache.get(ptc.sourcePhotoId);
        if (src === undefined && !sourcePhotoCache.has(ptc.sourcePhotoId)) {
          src =
            newPhotos.find((p) => p.id === ptc.sourcePhotoId) ??
            (await photoStore.get(ptc.sourcePhotoId));
          sourcePhotoCache.set(ptc.sourcePhotoId, src);
        }

        if (!src) {
          throw new Error(`クローン元の写真レコードが見つかりません (sourcePhotoId: ${ptc.sourcePhotoId})`);
        }

        // bottleId の決定
        let targetBottleId = ptc.bottleId;
        if (!targetBottleId) {
          const ownerBottle = bottles.find((b) => b.photoIds.includes(ptc.newPhotoId));
          targetBottleId = ownerBottle ? ownerBottle.id : src.bottleId;
        }

        clonedPhotos.push({
          id: ptc.newPhotoId,
          bottleId: targetBottleId,
          mimeType: src.mimeType,
          dataUrl: src.dataUrl,
          width: src.width,
          height: src.height,
          byteSize: src.byteSize,
          contentHash: src.contentHash,
          driveFileId: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          deleted: false,
        });
      }
    }

    // 2. ボトル全件保存
    for (const bottle of bottles) {
      await bottleStore.put(bottle);
    }

    // 3. 新規写真保存（いずれかのボトルから直接参照されている写真のみ保存）
    const allReferencedPhotoIds = new Set(bottles.flatMap((b) => b.photoIds));
    for (const photo of newPhotos) {
      if (allReferencedPhotoIds.has(photo.id)) {
        await photoStore.put(photo);
      }
    }

    // 4. クローン写真保存
    for (const photo of clonedPhotos) {
      await photoStore.put(photo);
    }

    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // 既に abort 済みの場合は無視
    }
    // tx.done の AbortError を消費して Unhandled Rejection を防ぐ
    await tx.done.catch(() => {});
    throw err;
  }
}

/**
 * ボトルを物理削除する（テスト・データクリア用）
 */
export async function hardDeleteBottle(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('bottles', id);
}

// ==========================================
// 写真操作 (Photos CRUD)
// ==========================================

/**
 * 全写真を取得する（既定では論理削除済みを除外）
 */
export async function getAllPhotos(includeDeleted: boolean = false): Promise<PhotoRecord[]> {
  const db = await getDb();
  const all = await db.getAll('photos');
  if (includeDeleted) {
    return all;
  }
  return all.filter((p) => !p.deleted);
}

/**
 * ID で単一写真を取得する
 */
export async function getPhoto(id: string): Promise<PhotoRecord | undefined> {
  const db = await getDb();
  return db.get('photos', id);
}

/**
 * 特定のボトルに紐づく写真一覧を取得する
 */
export async function getPhotosByBottleId(bottleId: string, includeDeleted: boolean = false): Promise<PhotoRecord[]> {
  const db = await getDb();
  const photos = await db.getAllFromIndex('photos', 'by_bottleId', bottleId);
  if (includeDeleted) {
    return photos;
  }
  return photos.filter((p) => !p.deleted);
}

/**
 * 写真を保存する
 */
export async function savePhoto(photo: PhotoRecord): Promise<void> {
  const db = await getDb();
  await db.put('photos', photo);
}

/**
 * 複数写真を一括保存する
 */
export async function savePhotos(photos: PhotoRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('photos', 'readwrite');
  for (const photo of photos) {
    await tx.store.put(photo);
  }
  await tx.done;
}

/**
 * 写真を論理削除する
 */
export async function deletePhoto(id: string, nowIso: string = new Date().toISOString()): Promise<void> {
  const db = await getDb();
  const photo = await db.get('photos', id);
  if (photo) {
    photo.deleted = true;
    photo.updatedAt = nowIso;
    await db.put('photos', photo);
  }
}

// ==========================================
// メタデータ操作 (Meta Store)
// ==========================================

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  const record = await db.get('meta', key);
  return record ? (record.value as T) : undefined;
}

export async function setMeta<T>(key: string, value: T, nowIso: string = new Date().toISOString()): Promise<void> {
  const db = await getDb();
  await db.put('meta', {
    key,
    value,
    updatedAt: nowIso,
  });
}

// ==========================================
// 同期コミット・メタデータ操作 (Sync Commit)
// ==========================================

export interface CommitSyncResultInput {
  /** 反映する全ボトルレコード（LWW マージ結果） */
  bottles: BottleRecord[];
  /** ローカル photos ストアから物理削除する写真 ID リスト (孤立・不要データ) */
  photosToPurge?: string[];
  /** ローカル photos ストアに追加または更新する写真レコード */
  photosToUpsert?: PhotoRecord[];
  /** 確定した同期完了日時 (ISO 8601 UTC) */
  syncedAtIso: string;
}

/**
 * 同期結果を単一トランザクションで IndexedDB にアトミック反映する
 */
export async function commitSyncResultToDb(input: CommitSyncResultInput): Promise<void> {
  const { bottles, photosToPurge = [], photosToUpsert = [], syncedAtIso } = input;
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  const bottleStore = tx.objectStore('bottles');
  const photoStore = tx.objectStore('photos');
  const metaStore = tx.objectStore('meta');

  // 1. ボトル全件 put
  for (const b of bottles) {
    await bottleStore.put(b);
  }

  // 2. 孤立・削除済み写真の物理削除
  for (const pid of photosToPurge) {
    await photoStore.delete(pid);
  }

  // 3. 新規ダウンロード・更新写真の保存
  for (const p of photosToUpsert) {
    await photoStore.put(p);
  }

  // 4. pendingDeletedPhotos のクリア
  await metaStore.put({
    key: 'pendingDeletedPhotos',
    value: [],
    updatedAt: syncedAtIso,
  });

  // 5. lastSyncAt の更新
  await metaStore.put({
    key: 'lastSyncAt',
    value: syncedAtIso,
    updatedAt: syncedAtIso,
  });

  // 6. 一時ダウンロードキャッシュがあれば削除
  await metaStore.delete('syncDownloadCache');

  await tx.done;
}

/**
 * 未同期の削除予定写真メタデータを取得する
 */
export async function getPendingDeletedPhotos(): Promise<PhotoSyncMeta[]> {
  const meta = await getMeta<PhotoSyncMeta[]>('pendingDeletedPhotos');
  return Array.isArray(meta) ? meta : [];
}

/**
 * 未同期の削除予定写真メタデータをクリアする
 */
export async function clearPendingDeletedPhotos(nowIso: string = new Date().toISOString()): Promise<void> {
  await setMeta<PhotoSyncMeta[]>('pendingDeletedPhotos', [], nowIso);
}

// ==========================================
// バックアップ書き出し・読み込み (Export / Import)
// ==========================================

/**
 * IndexedDB 内の全データをバックアップ形式（BackupData）で書き出す
 * 論理削除済みのボトル・写真も含めて出力
 */
export async function exportBackupData(nowIso: string = new Date().toISOString()): Promise<BackupData> {
  const db = await getDb();
  const bottles = await db.getAll('bottles');
  const photos = await db.getAll('photos');

  const backup: BackupData = {
    schemaVersion: 1,
    exportedAt: nowIso,
    bottles,
    photos,
  };

  await setMeta('lastBackupAt', nowIso, nowIso);
  return backup;
}

export type ImportBackupResult =
  | { success: true; count: { bottles: number; photos: number } }
  | { success: false; error: string };

/**
 * バックアップデータを検証し、整合性が確認された場合のみ IndexedDB に復元する
 *
 * 要件:
 * - 読み込み前の厳密検証（validateBackupData）
 * - 検証失敗時は既存データを一切変更せずエラーを返す（アトミックな拒否）
 * - 検証成功時のみ、単一トランザクション内で既存データをクリアして新しいデータを投入する
 */
export async function importBackupData(raw: unknown): Promise<ImportBackupResult> {
  // 1. スキーマ・整合性・参照関係の厳密検証
  const valResult = validateBackupData(raw);
  if (!valResult.success) {
    return { success: false, error: valResult.error };
  }

  const { bottles, photos } = valResult.data;
  const db = await getDb();

  // 2. 単一トランザクション内で安全に既存クリア＆一括投入
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  try {
    await tx.objectStore('bottles').clear();
    await tx.objectStore('photos').clear();

    for (const bottle of bottles) {
      await tx.objectStore('bottles').put(bottle);
    }
    for (const photo of photos) {
      await tx.objectStore('photos').put(photo);
    }

    const nowIso = new Date().toISOString();
    await tx.objectStore('meta').put({
      key: 'lastImportAt',
      value: nowIso,
      updatedAt: nowIso,
    });

    await tx.done;

    return {
      success: true,
      count: {
        bottles: bottles.length,
        photos: photos.length,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `データベースへの書き込み中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ==========================================
// サンプルデータ読み込み・全クリア
// ==========================================

/**
 * 受入確認用サンプルデータを IndexedDB に一括投入する
 */
export async function loadSampleData(): Promise<{ bottles: number; photos: number }> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');

  await tx.objectStore('bottles').clear();
  await tx.objectStore('photos').clear();

  for (const b of SAMPLE_BOTTLES) {
    await tx.objectStore('bottles').put(b);
  }
  for (const p of SAMPLE_PHOTOS) {
    await tx.objectStore('photos').put(p);
  }

  const nowIso = new Date().toISOString();
  await tx.objectStore('meta').put({
    key: 'isSampleDataLoaded',
    value: true,
    updatedAt: nowIso,
  });

  await tx.done;

  return {
    bottles: SAMPLE_BOTTLES.length,
    photos: SAMPLE_PHOTOS.length,
  };
}

/**
 * データベースの全ストアを完全にクリアする
 */
export async function clearDatabase(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  await tx.objectStore('bottles').clear();
  await tx.objectStore('photos').clear();
  await tx.objectStore('meta').clear();
  await tx.done;
}

// ==========================================
// 同期設定・キャッシュ操作 (Sync Config & Cache)
// ==========================================

/**
 * 端末内の同期接続設定を取得する
 */
export async function getSyncConfig(): Promise<SyncConnectionConfig | null> {
  const meta = await getMeta<SyncConnectionConfig>('syncConfig');
  return meta ?? null;
}

/**
 * 端末内の同期接続設定を保存する
 */
export async function saveSyncConfig(config: SyncConnectionConfig): Promise<void> {
  await setMeta<SyncConnectionConfig>('syncConfig', config, config.updatedAt);
}

/**
 * 最終同期日時を取得する (ISO 8601 UTC または null)
 */
export async function getLastSyncAt(): Promise<string | null> {
  const meta = await getMeta<string>('lastSyncAt');
  return typeof meta === 'string' && meta.length > 0 ? meta : null;
}

/**
 * 写真レコードの driveFileId を更新する
 */
export async function updatePhotoDriveFileId(
  photoId: string,
  driveFileId: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('photos', 'readwrite');
  const store = tx.objectStore('photos');
  const existing = await store.get(photoId);
  if (existing) {
    await store.put({
      ...existing,
      driveFileId,
      updatedAt: nowIso,
    });
  }
  await tx.done;
}

/**
 * 一時ダウンロードキャッシュの写真一覧を取得する
 */
export async function getSyncDownloadCache(): Promise<PhotoRecord[]> {
  const meta = await getMeta<PhotoRecord[]>('syncDownloadCache');
  return Array.isArray(meta) ? meta : [];
}

/**
 * 一時ダウンロードキャッシュに写真を追加・保存する (レジューム用)
 */
export async function saveSyncDownloadCache(
  photos: PhotoRecord[],
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  const metaStore = tx.objectStore('meta');
  const existingRec = await metaStore.get('syncDownloadCache');
  const existingList = Array.isArray(existingRec?.value) ? (existingRec.value as PhotoRecord[]) : [];

  const map = new Map<string, PhotoRecord>(existingList.map((p) => [p.id, p]));
  for (const p of photos) {
    map.set(p.id, p);
  }

  await metaStore.put({
    key: 'syncDownloadCache',
    value: Array.from(map.values()),
    updatedAt: nowIso,
  });
  await tx.done;
}

/**
 * 一時ダウンロードキャッシュを完全上書き・保存する（無効なキャッシュの破棄用）
 */
export async function setSyncDownloadCache(
  photos: PhotoRecord[],
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const db = await getDb();
  if (photos.length === 0) {
    await db.delete('meta', 'syncDownloadCache');
  } else {
    await db.put('meta', {
      key: 'syncDownloadCache',
      value: photos,
      updatedAt: nowIso,
    });
  }
}

/**
 * 一時ダウンロードキャッシュをクリアする
 */
export async function clearSyncDownloadCache(): Promise<void> {
  const db = await getDb();
  await db.delete('meta', 'syncDownloadCache');
}
