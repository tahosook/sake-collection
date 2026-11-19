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
import { validateBackupData, validateBottleRecord, validatePhotoRecord } from '../domain/validation';
import { hasSampleDataRecords, sanitizeDeletedBottle, toPhotoSyncMeta } from '../domain/syncMerge';

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
 * ボトルを論理削除する（deleted = true, updatedAt = now, photoIds = [], primaryPhotoId = null）
 * 紐づく写真は photos ストアから物理削除し、Drive 同期済み（driveFileId !== null）だった写真は
 * 次回同期での Drive ゴミ箱移動のために meta ストアの 'pendingDeletedPhotos' に退避する。
 * （saveBottleWithPhotos と方式を揃え、直後のバックアップ書き出しにおける参照整合性を保証する）
 */
export async function deleteBottle(id: string, nowIso: string = new Date().toISOString()): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  const bottleStore = tx.objectStore('bottles');
  const photoStore = tx.objectStore('photos');
  const metaStore = tx.objectStore('meta');

  const bottle = await bottleStore.get(id);
  if (bottle) {
    bottle.deleted = true;
    bottle.updatedAt = nowIso;
    bottle.photoIds = [];
    bottle.primaryPhotoId = null;
    await bottleStore.put(bottle);

    // 紐づく写真を取得し、同期済み写真の退避と photos ストアからの物理削除を行う
    const relatedPhotos = await photoStore.index('by_bottleId').getAll(id);
    if (relatedPhotos.length > 0) {
      const removedSyncedMetas: PhotoSyncMeta[] = [];

      for (const p of relatedPhotos) {
        if (p.driveFileId !== null) {
          const meta = toPhotoSyncMeta(p);
          removedSyncedMetas.push({
            ...meta,
            deleted: true,
            updatedAt: nowIso,
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
          updatedAt: nowIso,
        });
      }
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
  /** 同期開始時のローカルボトル updatedAt スナップショット (S2: 同期中編集の保護用) */
  snapshotBottleUpdatedAt?: Record<string, string>;
  /** 同期開始時にサーバーへ送信済みだった pendingDeletedPhotos スナップショット (S2) */
  sentPendingDeletedPhotos?: Array<{ id: string; updatedAt: string }>;
  /** 今回の同期で処理した pendingBackupRestoreAt の値 (M1) */
  consumedBackupRestoreAt?: string;
}

export interface CommitSyncResultOutput {
  /** 同期中にローカルで発生した変更を保護したため、再同期が推奨されるかどうか */
  hasPendingLocalChanges: boolean;
}

/**
 * 同期結果を単一トランザクションで IndexedDB にアトミック反映する
 */
export async function commitSyncResultToDb(input: CommitSyncResultInput): Promise<CommitSyncResultOutput> {
  const {
    bottles,
    photosToPurge = [],
    photosToUpsert = [],
    syncedAtIso,
    snapshotBottleUpdatedAt,
    sentPendingDeletedPhotos,
    consumedBackupRestoreAt,
  } = input;
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  const bottleStore = tx.objectStore('bottles');
  const photoStore = tx.objectStore('photos');
  const metaStore = tx.objectStore('meta');

  const existingBottles = await bottleStore.getAll();
  const existingBottleMap = new Map<string, BottleRecord>(existingBottles.map((b) => [b.id, b]));
  const existingPhotos = await photoStore.getAll();
  const effectivePhotoIds = new Set<string>(existingPhotos.map((p) => p.id));

  let hasPendingLocalChanges = false;
  const finalBottleMap = new Map<string, BottleRecord>();

  // 1. リモートボトルと同期中ローカル編集の競合解決 (S2)
  for (const b of bottles) {
    const sanitizedRemote = sanitizeDeletedBottle(b);
    const existingLocal = existingBottleMap.get(b.id);

    if (snapshotBottleUpdatedAt !== undefined && existingLocal !== undefined) {
      const wasInSnapshot = Object.prototype.hasOwnProperty.call(snapshotBottleUpdatedAt, b.id);
      const snapshotUpdatedAt = wasInSnapshot ? snapshotBottleUpdatedAt[b.id] : undefined;
      const modifiedLocallyDuringSync = !wasInSnapshot || existingLocal.updatedAt !== snapshotUpdatedAt;

      if (modifiedLocallyDuringSync) {
        // 同期中にローカル変更が発生したレコードは、リモートの updatedAt が同値・未来であってもローカル版を保持する
        finalBottleMap.set(b.id, sanitizeDeletedBottle(existingLocal));
        hasPendingLocalChanges = true;
        continue;
      }
    }

    finalBottleMap.set(b.id, sanitizedRemote);
  }

  // 同期中にローカルで新規作成（または変更）されたがリモート結果に含まれないボトルを保護 (S2)
  if (snapshotBottleUpdatedAt !== undefined) {
    for (const [localId, existingLocal] of existingBottleMap.entries()) {
      if (!finalBottleMap.has(localId)) {
        const wasInSnapshot = Object.prototype.hasOwnProperty.call(snapshotBottleUpdatedAt, localId);
        const snapshotUpdatedAt = wasInSnapshot ? snapshotBottleUpdatedAt[localId] : undefined;
        if (!wasInSnapshot || existingLocal.updatedAt !== snapshotUpdatedAt) {
          finalBottleMap.set(localId, sanitizeDeletedBottle(existingLocal));
          hasPendingLocalChanges = true;
        }
      }
    }
  }

  // 最終的に有効なボトルが参照している写真 ID 集合
  const activeReferencedPhotoIds = new Set<string>();
  for (const fb of finalBottleMap.values()) {
    if (!fb.deleted) {
      for (const pid of fb.photoIds) {
        activeReferencedPhotoIds.add(pid);
      }
    }
  }

  // 2. 孤立・削除済み写真の物理削除 (保護された同期中ローカル変更が参照している写真は削除しない)
  for (const pid of photosToPurge) {
    if (!activeReferencedPhotoIds.has(pid)) {
      await photoStore.delete(pid);
      effectivePhotoIds.delete(pid);
    }
  }

  // 3. 新規ダウンロード・更新写真の保存 (同期中に親ボトルが削除された場合は保存しない)
  for (const p of photosToUpsert) {
    const parentBottle = finalBottleMap.get(p.bottleId);
    if (parentBottle && !parentBottle.deleted && parentBottle.photoIds.includes(p.id)) {
      await photoStore.put(p);
      effectivePhotoIds.add(p.id);
    } else if (effectivePhotoIds.has(p.id)) {
      await photoStore.delete(p.id);
      effectivePhotoIds.delete(p.id);
    }
  }

  // 4. ボトル全件 put (M4: ローカル photos ストアに実体が存在しない参照を除外して双方向整合を保持。updatedAt は維持)
  for (const fb of finalBottleMap.values()) {
    if (fb.deleted) {
      await bottleStore.put({
        ...fb,
        photoIds: [],
        primaryPhotoId: null,
      });
    } else {
      const cleanedPhotoIds = fb.photoIds.filter((pid) => effectivePhotoIds.has(pid));
      const cleanedPrimary =
        fb.primaryPhotoId && cleanedPhotoIds.includes(fb.primaryPhotoId)
          ? fb.primaryPhotoId
          : cleanedPhotoIds[0] ?? null;
      if (cleanedPhotoIds.length !== fb.photoIds.length || cleanedPrimary !== fb.primaryPhotoId) {
        await bottleStore.put({
          ...fb,
          photoIds: cleanedPhotoIds,
          primaryPhotoId: cleanedPrimary,
        });
      } else {
        await bottleStore.put(fb);
      }
    }
  }

  // 5. pendingDeletedPhotos の差分クリア (S2: 同期中に新しく追加された削除予定は残す)
  if (sentPendingDeletedPhotos !== undefined) {
    const sentMap = new Map<string, string>(sentPendingDeletedPhotos.map((item) => [item.id, item.updatedAt]));
    const existingMetaRecord = await metaStore.get('pendingDeletedPhotos');
    const currentPending = Array.isArray(existingMetaRecord?.value)
      ? (existingMetaRecord.value as PhotoSyncMeta[])
      : [];
    const remainingPending = currentPending.filter((item) => {
      const sentAt = sentMap.get(item.id);
      return sentAt === undefined || item.updatedAt > sentAt;
    });
    if (remainingPending.length > 0) {
      hasPendingLocalChanges = true;
    }
    await metaStore.put({
      key: 'pendingDeletedPhotos',
      value: remainingPending,
      updatedAt: syncedAtIso,
    });
  } else {
    await metaStore.put({
      key: 'pendingDeletedPhotos',
      value: [],
      updatedAt: syncedAtIso,
    });
  }

  // 6. lastSyncAt の更新
  await metaStore.put({
    key: 'lastSyncAt',
    value: syncedAtIso,
    updatedAt: syncedAtIso,
  });

  // 7. 一時ダウンロードキャッシュがあれば削除
  await metaStore.delete('syncDownloadCache');

  // 8. 処理済み pendingBackupRestoreAt のクリア (同期中の別復元は消さない)
  if (consumedBackupRestoreAt !== undefined) {
    const restoreRec = await metaStore.get('pendingBackupRestoreAt');
    if (restoreRec?.value === consumedBackupRestoreAt) {
      await metaStore.delete('pendingBackupRestoreAt');
    }
  }

  await tx.done;

  return { hasPendingLocalChanges };
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

export interface ExportBackupBlobResult {
  blob: Blob;
  bottleCount: number;
  photoCount: number;
  repairedReferenceCount: number;
}

const BACKUP_EXPORT_CHUNK_BYTES = 512 * 1024; // 512KB ごとに Blob チャンク化 (S6)

function normalizeBottleForExport(
  b: BottleRecord,
  existingPhotoIdsForBottle: Set<string>
): { bottle: BottleRecord; repairedCount: number } {
  if (b.deleted) {
    if (b.photoIds.length === 0 && b.primaryPhotoId === null) {
      return { bottle: b, repairedCount: 0 };
    }
    return {
      bottle: {
        ...b,
        photoIds: [],
        primaryPhotoId: null,
      },
      repairedCount: 0,
    };
  }

  const cleanedPhotoIds = b.photoIds.filter((pid) => existingPhotoIdsForBottle.has(pid));
  const repairedCount = b.photoIds.length - cleanedPhotoIds.length;
  const cleanedPrimary =
    b.primaryPhotoId && cleanedPhotoIds.includes(b.primaryPhotoId)
      ? b.primaryPhotoId
      : cleanedPhotoIds[0] ?? null;

  if (repairedCount > 0 || cleanedPrimary !== b.primaryPhotoId) {
    return {
      bottle: {
        ...b,
        photoIds: cleanedPhotoIds,
        primaryPhotoId: cleanedPrimary,
      },
      repairedCount,
    };
  }

  return { bottle: b, repairedCount: 0 };
}

/**
 * IndexedDB 内の全データをバックアップ形式（BackupData）で書き出す
 *
 * 整合性保証 (M4):
 * - deleted === true のボトルは photoIds: [], primaryPhotoId: null に正規化する。
 * - 有効ボトルに欠損写真参照がある場合は自動修復して双方向整合を保つ。
 * - 出力確定前に validateBackupData による自己検証を必ず通し、失敗時は lastBackupAt を更新せず例外を投げる。
 */
export async function exportBackupData(nowIso: string = new Date().toISOString()): Promise<BackupData> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos'], 'readonly');
  const rawBottles = await tx.objectStore('bottles').getAll();
  const rawPhotos = await tx.objectStore('photos').getAll();
  await tx.done;

  const rawBottleMap = new Map<string, BottleRecord>(rawBottles.map((b) => [b.id, b]));
  const actualPhotoIdsByBottle = new Map<string, Set<string>>();

  const photos = rawPhotos.filter((p) => {
    if (p.deleted) {
      return false;
    }
    const parent = rawBottleMap.get(p.bottleId);
    if (!parent || parent.deleted || !parent.photoIds.includes(p.id)) {
      return false;
    }
    let idSet = actualPhotoIdsByBottle.get(p.bottleId);
    if (!idSet) {
      idSet = new Set<string>();
      actualPhotoIdsByBottle.set(p.bottleId, idSet);
    }
    idSet.add(p.id);
    return true;
  });

  const bottles = rawBottles.map((b) => {
    const idSet = actualPhotoIdsByBottle.get(b.id) ?? new Set<string>();
    return normalizeBottleForExport(b, idSet).bottle;
  });

  const backup: BackupData = {
    schemaVersion: 1,
    exportedAt: nowIso,
    bottles,
    photos,
  };

  // M4: 書き出し自己検証
  const valRes = validateBackupData(backup);
  if (!valRes.success) {
    throw new Error(`バックアップデータの自己検証に失敗しました: ${valRes.error}`);
  }

  await setMeta('lastBackupAt', nowIso, nowIso);
  return valRes.data;
}

/**
 * IndexedDB 内の全データを省メモリ（カーソル逐次走査＋チャンク Blob 化）で JSON Blob として書き出す (S6 / M4)
 *
 * - photos ストアを openCursor() で1件ずつ検証・コンパクトシリアライズし、512KB ごとに Blob へ逃がして文字列参照を解放する。
 * - 書き出し確定前に全レコードのスキーマおよび双方向整合を検証し、失敗時は lastBackupAt を更新せず例外を投げる。
 */
export async function exportBackupBlob(
  nowIso: string = new Date().toISOString()
): Promise<ExportBackupBlobResult> {
  const headerCheck = validateBackupData({
    schemaVersion: 1,
    exportedAt: nowIso,
    bottles: [],
    photos: [],
  });
  if (!headerCheck.success) {
    throw new Error(`バックアップデータの自己検証に失敗しました: ${headerCheck.error}`);
  }

  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos'], 'readonly');
  const rawBottles = await tx.objectStore('bottles').getAll();
  const rawBottleMap = new Map<string, BottleRecord>(rawBottles.map((b) => [b.id, b]));

  const actualPhotoIdsByBottle = new Map<string, Set<string>>();
  const seenPhotoIds = new Set<string>();
  const photoBlobParts: Blob[] = [];
  let currentChunkStrings: string[] = [];
  let currentChunkBytes = 0;
  let photoCount = 0;

  let cursor = await tx.objectStore('photos').openCursor();
  while (cursor) {
    const p = cursor.value;
    if (!p.deleted) {
      const parent = rawBottleMap.get(p.bottleId);
      if (parent && !parent.deleted && parent.photoIds.includes(p.id)) {
        if (seenPhotoIds.has(p.id)) {
          throw new Error(`バックアップデータの自己検証に失敗しました: 重複する写真 ID が見つかりました: ${p.id}`);
        }
        const photoVal = validatePhotoRecord(p, photoCount + 1);
        if (!photoVal.success) {
          throw new Error(`バックアップデータの自己検証に失敗しました: ${photoVal.error}`);
        }
        seenPhotoIds.add(p.id);

        let idSet = actualPhotoIdsByBottle.get(p.bottleId);
        if (!idSet) {
          idSet = new Set<string>();
          actualPhotoIdsByBottle.set(p.bottleId, idSet);
        }
        idSet.add(p.id);

        const serialized = JSON.stringify(photoVal.data);
        const piece = photoCount > 0 ? `,${serialized}` : serialized;
        currentChunkStrings.push(piece);
        currentChunkBytes += piece.length;
        photoCount++;

        if (currentChunkBytes >= BACKUP_EXPORT_CHUNK_BYTES) {
          photoBlobParts.push(new Blob(currentChunkStrings, { type: 'application/json' }));
          currentChunkStrings = [];
          currentChunkBytes = 0;
        }
      }
    }
    cursor = await cursor.continue();
  }
  await tx.done;

  if (currentChunkStrings.length > 0) {
    photoBlobParts.push(new Blob(currentChunkStrings, { type: 'application/json' }));
    currentChunkStrings = [];
  }

  const normalizedBottles: BottleRecord[] = [];
  const seenBottleIds = new Set<string>();
  let repairedReferenceCount = 0;

  for (let i = 0; i < rawBottles.length; i++) {
    const rawBottle = rawBottles[i]!;
    const idSet = actualPhotoIdsByBottle.get(rawBottle.id) ?? new Set<string>();
    const { bottle: normalized, repairedCount } = normalizeBottleForExport(rawBottle, idSet);
    repairedReferenceCount += repairedCount;

    if (seenBottleIds.has(normalized.id)) {
      throw new Error(`バックアップデータの自己検証に失敗しました: 重複するボトル ID が見つかりました: ${normalized.id}`);
    }
    const bottleVal = validateBottleRecord(normalized, i + 1);
    if (!bottleVal.success) {
      throw new Error(`バックアップデータの自己検証に失敗しました: ${bottleVal.error}`);
    }
    seenBottleIds.add(normalized.id);
    normalizedBottles.push(bottleVal.data);
  }

  const header = `{"schemaVersion":1,"exportedAt":${JSON.stringify(nowIso)},"bottles":${JSON.stringify(normalizedBottles)},"photos":[`;
  const blob = new Blob([header, ...photoBlobParts, ']}'], { type: 'application/json' });

  await setMeta('lastBackupAt', nowIso, nowIso);
  return {
    blob,
    bottleCount: normalizedBottles.length,
    photoCount,
    repairedReferenceCount,
  };
}

export type ImportBackupResult =
  | { success: true; count: { bottles: number; photos: number } }
  | { success: false; error: string };

/**
 * バックアップデータを検証し、整合性が確認された場合のみ IndexedDB に復元する (M1 対応)
 *
 * 要件:
 * - 読み込み前の厳密検証（validateBackupData）
 * - 検証失敗時は既存データを一切変更せずエラーを返す（アトミックな拒否）
 * - 検証成功時:
 *   - 復元基準時刻 restoredAt を既存データ・バックアップ内の最大 updatedAt より真に新しい時刻へ確定
 *   - 復元ボトル・写真の updatedAt を restoredAt に昇格、復元写真の driveFileId を null にリセット
 *   - 復元前にこの端末に存在しバックアップに含まれないボトルをトームストーン化し、同期済み写真を pendingDeletedPhotos へ退避
 *   - syncDownloadCache を削除、isSampleDataLoaded を実データ有無へ整合、pendingBackupRestoreAt を記録
 */
export async function importBackupData(
  raw: unknown,
  nowIsoInput?: string
): Promise<ImportBackupResult> {
  // 1. スキーマ・整合性・参照関係の厳密検証
  const valResult = validateBackupData(raw);
  if (!valResult.success) {
    return { success: false, error: valResult.error };
  }

  const { bottles, photos } = valResult.data;
  const db = await getDb();

  // 2. 単一トランザクション内で既存退避・クリア・昇格投入
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  try {
    const bottleStore = tx.objectStore('bottles');
    const photoStore = tx.objectStore('photos');
    const metaStore = tx.objectStore('meta');

    const existingBottles = await bottleStore.getAll();
    const existingPhotos = await photoStore.getAll();
    const existingPendingMeta = await metaStore.get('pendingDeletedPhotos');
    const lastSyncRec = await metaStore.get('lastSyncAt');

    const baseNowMs = nowIsoInput ? Date.parse(nowIsoInput) : Date.now();
    let maxExistingMs = Number.isFinite(baseNowMs) ? baseNowMs : Date.now();

    const considerTimestamp = (iso: unknown) => {
      if (typeof iso === 'string') {
        const ms = Date.parse(iso);
        if (Number.isFinite(ms) && ms >= maxExistingMs) {
          maxExistingMs = ms + 1;
        }
      }
    };

    for (const eb of existingBottles) {
      considerTimestamp(eb.updatedAt);
    }
    for (const ep of existingPhotos) {
      considerTimestamp(ep.updatedAt);
    }
    for (const ib of bottles) {
      considerTimestamp(ib.updatedAt);
    }
    for (const ip of photos) {
      considerTimestamp(ip.updatedAt);
    }
    considerTimestamp(lastSyncRec?.value);

    const restoredAt = new Date(maxExistingMs).toISOString();

    const importedBottleIdSet = new Set(bottles.map((b) => b.id));
    const importedPhotoIdSet = new Set(photos.map((p) => p.id));

    const bottlesToPut: BottleRecord[] = bottles.map((b) =>
      sanitizeDeletedBottle({
        ...b,
        updatedAt: restoredAt,
      })
    );

    // 復元前にこの端末に存在したバックアップ外ボトルをトームストーンとして残す
    for (const eb of existingBottles) {
      if (!importedBottleIdSet.has(eb.id)) {
        bottlesToPut.push({
          ...eb,
          deleted: true,
          updatedAt: restoredAt,
          photoIds: [],
          primaryPhotoId: null,
        });
      }
    }

    const photosToPut: PhotoRecord[] = photos.map((p) => ({
      ...p,
      driveFileId: null,
      updatedAt: restoredAt,
    }));

    // pendingDeletedPhotos の更新（復元対象写真 ID の古い削除予約を除外し、今回消える同期済み写真を追記）
    const existingPendingList = Array.isArray(existingPendingMeta?.value)
      ? (existingPendingMeta.value as PhotoSyncMeta[])
      : [];
    const pendingMap = new Map<string, PhotoSyncMeta>();
    for (const pm of existingPendingList) {
      if (!importedPhotoIdSet.has(pm.id)) {
        pendingMap.set(pm.id, pm);
      }
    }
    for (const ep of existingPhotos) {
      if (!importedPhotoIdSet.has(ep.id) && ep.driveFileId !== null) {
        pendingMap.set(ep.id, {
          ...toPhotoSyncMeta(ep),
          deleted: true,
          updatedAt: restoredAt,
        });
      }
    }

    await bottleStore.clear();
    await photoStore.clear();

    for (const bottle of bottlesToPut) {
      await bottleStore.put(bottle);
    }
    for (const photo of photosToPut) {
      await photoStore.put(photo);
    }

    await metaStore.put({
      key: 'pendingDeletedPhotos',
      value: Array.from(pendingMap.values()),
      updatedAt: restoredAt,
    });
    await metaStore.put({
      key: 'isSampleDataLoaded',
      value: hasSampleDataRecords(bottles),
      updatedAt: restoredAt,
    });
    await metaStore.put({
      key: 'pendingBackupRestoreAt',
      value: restoredAt,
      updatedAt: restoredAt,
    });
    await metaStore.put({
      key: 'lastImportAt',
      value: restoredAt,
      updatedAt: restoredAt,
    });
    await metaStore.delete('syncDownloadCache');

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

/**
 * 端末時計がサーバー時刻より遅れている場合のクロックスキュー補正 (M1)
 * 復元済みレコードおよび pendingDeletedPhotos の updatedAt を bumpedIso へ引き上げる
 */
export async function bumpLocalRecordsUpdatedAt(bumpedIso: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bottles', 'photos', 'meta'], 'readwrite');
  const bottleStore = tx.objectStore('bottles');
  const photoStore = tx.objectStore('photos');
  const metaStore = tx.objectStore('meta');

  const bottles = await bottleStore.getAll();
  for (const b of bottles) {
    if (b.updatedAt < bumpedIso) {
      await bottleStore.put({ ...b, updatedAt: bumpedIso });
    }
  }

  const photos = await photoStore.getAll();
  for (const p of photos) {
    if (p.updatedAt < bumpedIso) {
      await photoStore.put({ ...p, updatedAt: bumpedIso });
    }
  }

  const pendingRec = await metaStore.get('pendingDeletedPhotos');
  if (Array.isArray(pendingRec?.value)) {
    const updatedPending = (pendingRec.value as PhotoSyncMeta[]).map((pm) =>
      pm.updatedAt < bumpedIso ? { ...pm, updatedAt: bumpedIso } : pm
    );
    await metaStore.put({
      key: 'pendingDeletedPhotos',
      value: updatedPending,
      updatedAt: bumpedIso,
    });
  }

  await metaStore.put({
    key: 'pendingBackupRestoreAt',
    value: bumpedIso,
    updatedAt: bumpedIso,
  });

  await tx.done;
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
