import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { BottleRecord, PhotoRecord, BackupData, SakeCategory, BottleStatus } from '../types/sake';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../data/sampleData';
import { validateBackupData } from '../domain/validation';

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
 */
export async function deleteBottle(id: string, nowIso: string = new Date().toISOString()): Promise<void> {
  const db = await getDb();
  const bottle = await db.get('bottles', id);
  if (bottle) {
    bottle.deleted = true;
    bottle.updatedAt = nowIso;
    await db.put('bottles', bottle);
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
