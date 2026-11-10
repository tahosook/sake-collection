import { BottleRecord, PhotoRecord, PhotoSyncMeta } from '../types/sake';
import { SAMPLE_BOTTLES } from '../data/sampleData';

/**
 * 2つの同一 ID を持つ BottleRecord を LWW (Last-Write-Wins: 最終更新日時優先) でマージする純粋関数
 *
 * ルール:
 * 1. updatedAt (ISO 8601 UTC) を比較し、新しい方を採用する。
 * 2. updatedAt が完全に一致する場合の決定的タイブレーク:
 *    - deleted === true を優先（一方が削除されていれば削除を採用）。
 *    - deleted も一致する場合はリモート（サーバー側）レコードを維持する。
 */
export function mergeBottleRecords(local: BottleRecord, remote: BottleRecord): BottleRecord {
  if (local.id !== remote.id) {
    throw new Error(`ID が一致しないボトルはマージできません (local: ${local.id}, remote: ${remote.id})`);
  }

  if (local.updatedAt > remote.updatedAt) {
    return local;
  }
  if (remote.updatedAt > local.updatedAt) {
    return remote;
  }

  // 同一日時のタイブレーク: deleted === true を優先
  if (local.deleted && !remote.deleted) {
    return local;
  }
  if (remote.deleted && !local.deleted) {
    return remote;
  }

  // 削除状態も同じならリモートを維持
  return remote;
}

export interface MergeBottleCollectionsOptions {
  localBottles: BottleRecord[];
  remoteBottles: BottleRecord[];
  /** 空・初期状態の端末からの同期保護フラグ */
  isInitialEmptyClient?: boolean;
}

/**
 * ローカルとリモートの全ボトルコレクションをマージする純粋関数
 *
 * 要件:
 * - isInitialEmptyClient === true（ローカルが0件）の場合、リモートの既存データを消さずそのまま採用する。
 * - 両方に存在するボトルは LWW でマージ。
 * - 片方にしか存在しないボトルはそのまま維持。
 * - 結果は id 昇順で安定ソートして返す。
 */
export function mergeBottleCollections(options: MergeBottleCollectionsOptions): BottleRecord[] {
  const { localBottles, remoteBottles, isInitialEmptyClient = false } = options;

  if (isInitialEmptyClient || localBottles.length === 0) {
    // 空端末保護: リモートのデータをそのまま全件復元
    return [...remoteBottles].sort((a, b) => a.id.localeCompare(b.id));
  }

  const remoteMap = new Map<string, BottleRecord>(remoteBottles.map((b) => [b.id, b]));
  const mergedMap = new Map<string, BottleRecord>();

  for (const local of localBottles) {
    const remote = remoteMap.get(local.id);
    if (remote) {
      mergedMap.set(local.id, mergeBottleRecords(local, remote));
    } else {
      mergedMap.set(local.id, local);
    }
  }

  for (const remote of remoteBottles) {
    if (!mergedMap.has(remote.id)) {
      mergedMap.set(remote.id, remote);
    }
  }

  return Array.from(mergedMap.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 2つの同一 ID を持つ PhotoSyncMeta を LWW でマージする純粋関数
 */
export function mergePhotoSyncMetas(local: PhotoSyncMeta, remote: PhotoSyncMeta): PhotoSyncMeta {
  if (local.id !== remote.id) {
    throw new Error(`ID が一致しない写真はマージできません (local: ${local.id}, remote: ${remote.id})`);
  }

  // driveFileId の引き継ぎ（一方が driveFileId を持っていれば維持）
  const resolvedDriveFileId = local.driveFileId ?? remote.driveFileId ?? null;

  let winningMeta: PhotoSyncMeta;
  if (local.updatedAt > remote.updatedAt) {
    winningMeta = local;
  } else if (remote.updatedAt > local.updatedAt) {
    winningMeta = remote;
  } else {
    // 同一日時: deleted === true 優先、さらに同一ならリモート優先
    if (local.deleted && !remote.deleted) {
      winningMeta = local;
    } else {
      winningMeta = remote;
    }
  }

  return {
    ...winningMeta,
    driveFileId: resolvedDriveFileId,
  };
}

/**
 * PhotoRecord から画像本体 (dataUrl) を除いた PhotoSyncMeta を生成するヘルパー関数
 */
export function toPhotoSyncMeta(photo: PhotoRecord): PhotoSyncMeta {
  return {
    id: photo.id,
    bottleId: photo.bottleId,
    mimeType: photo.mimeType,
    width: photo.width,
    height: photo.height,
    byteSize: photo.byteSize,
    contentHash: photo.contentHash,
    driveFileId: photo.driveFileId,
    createdAt: photo.createdAt,
    updatedAt: photo.updatedAt,
    deleted: photo.deleted,
  };
}

export interface ReconcilePhotosOptions {
  /** マージ済みの全ボトルレコード */
  mergedBottles: BottleRecord[];
  /** ローカルに現在保持されている写真（dataUrl を含む） */
  localPhotos: PhotoRecord[];
  /** リモート（サーバー）から受信した写真メタデータ */
  remotePhotoMetas: PhotoSyncMeta[];
  /** ローカルでボトルの photoIds から外され、未同期で削除予定の写真メタデータ */
  pendingDeletedPhotos?: PhotoSyncMeta[];
}

export interface ReconcilePhotosResult {
  /** 正規化された全写真メタデータ（サーバー・クライアント共通の正） */
  reconciledPhotoMetas: PhotoSyncMeta[];
  /** Drive への新規アップロードが必要なローカル写真 ID リスト */
  photosToUpload: string[];
  /** Drive からのダウンロードが必要な写真 ID リスト */
  photosToDownload: string[];
  /** contentHash 重複排除により driveFileId が解決された写真マッピング (photoId -> driveFileId) */
  deduplicatedDriveFileIds: Record<string, string>;
  /** ローカル IndexedDB photos ストアから物理削除すべき写真 ID リスト (孤立・不要データ) */
  photosToPurgeFromLocal: string[];
  /** ローカル IndexedDB photos ストアに残すべき有効な写真 ID リスト */
  localPhotoIdsToKeep: string[];
}

/**
 * 親ボトルの photoIds に基づいて写真の整合性を正規化し、
 * アップロード要否・不足ダウンロード対象・contentHash 重複排除・ローカル物理削除対象を算出する純粋関数
 *
 * 設計条件（docs/step3-4-design.md §3(2), §3(3)）:
 * 1. 写真メタデータの LWW マージ。
 * 2. 親ボトルの photoIds による正規化ルール:
 *    - ボトル b が存在し、b.photoIds.includes(photo.id) のとき: photo.deleted = b.deleted。
 *    - ボトル b が存在しない、または b.photoIds に photo.id が含まれないとき: photo.deleted = true。
 * 3. contentHash による Drive 側重複排除:
 *    - 同一 contentHash を持つ既存の有効な driveFileId があれば再利用し、新規 Drive アップロードをスキップ。
 * 4. ダウンロード対象:
 *    - 有効（deleted === false）かつローカルに dataUrl がなく、driveFileId があるもの。
 * 5. アップロード対象:
 *    - 有効（deleted === false）かつローカルに dataUrl があり、driveFileId が未取得かつ重複排除不可なもの。
 * 6. ローカル物理削除対象:
 *    - ローカルに存在する写真のうち、正規化後に deleted === true（外された写真、または削除済みボトルに属する写真）となったもの。
 *    - これにより、ローカル IndexedDB は常に parentBottle.photoIds.includes(photo.id) を満たし、
 *      バックアップ JSON の双方向整合性（validateBackupData）を完全に保つ。
 */
export function reconcilePhotosWithBottles(options: ReconcilePhotosOptions): ReconcilePhotosResult {
  const {
    mergedBottles,
    localPhotos,
    remotePhotoMetas,
    pendingDeletedPhotos = [],
  } = options;

  const bottleMap = new Map<string, BottleRecord>(mergedBottles.map((b) => [b.id, b]));
  const localPhotoMap = new Map<string, PhotoRecord>(localPhotos.map((p) => [p.id, p]));

  // 1. ローカル側メタデータ候補の作成（localPhotos + pendingDeletedPhotos）
  const localMetaMap = new Map<string, PhotoSyncMeta>();
  for (const lp of localPhotos) {
    const meta = toPhotoSyncMeta(lp);
    localMetaMap.set(meta.id, meta);
  }
  for (const pd of pendingDeletedPhotos) {
    const existing = localMetaMap.get(pd.id);
    if (!existing || pd.updatedAt >= existing.updatedAt) {
      localMetaMap.set(pd.id, pd);
    }
  }

  // 2. リモートメタデータとの LWW マージ
  const allPhotoIds = new Set<string>([
    ...localMetaMap.keys(),
    ...remotePhotoMetas.map((p) => p.id),
  ]);

  const remoteMetaMap = new Map<string, PhotoSyncMeta>(remotePhotoMetas.map((p) => [p.id, p]));
  const rawMergedMetas: PhotoSyncMeta[] = [];

  for (const id of allPhotoIds) {
    const lMeta = localMetaMap.get(id);
    const rMeta = remoteMetaMap.get(id);

    if (lMeta && rMeta) {
      rawMergedMetas.push(mergePhotoSyncMetas(lMeta, rMeta));
    } else if (lMeta) {
      rawMergedMetas.push(lMeta);
    } else if (rMeta) {
      rawMergedMetas.push(rMeta);
    }
  }

  // 3. 既存の有効な写真から contentHash -> driveFileId マッピングを構築（重複排除用）
  // 再利用候補は「deleted === false かつ親ボトルの photoIds に属する写真」のみに限定する。
  // 削除済み写真や親ボトルの photoIds から外された写真の driveFileId（Drive 側でゴミ箱に移動されるもの）を引き継がない。
  const isPhotoActiveAndBelongsToParent = (
    photoId: string,
    bottleId: string,
    isDeleted: boolean
  ): boolean => {
    if (isDeleted) {
      return false;
    }
    const parentBottle = bottleMap.get(bottleId);
    if (!parentBottle || parentBottle.deleted) {
      return false;
    }
    return parentBottle.photoIds.includes(photoId);
  };

  const knownHashToDriveId = new Map<string, string>();
  for (const meta of rawMergedMetas) {
    if (
      meta.driveFileId &&
      meta.contentHash &&
      isPhotoActiveAndBelongsToParent(meta.id, meta.bottleId, meta.deleted)
    ) {
      knownHashToDriveId.set(meta.contentHash, meta.driveFileId);
    }
  }
  for (const lp of localPhotos) {
    if (
      lp.driveFileId &&
      lp.contentHash &&
      isPhotoActiveAndBelongsToParent(lp.id, lp.bottleId, lp.deleted)
    ) {
      knownHashToDriveId.set(lp.contentHash, lp.driveFileId);
    }
  }

  // 4. 親ボトル photoIds による正規化と重複排除適用
  const reconciledPhotoMetas: PhotoSyncMeta[] = [];
  const deduplicatedDriveFileIds: Record<string, string> = {};

  for (const meta of rawMergedMetas) {
    const parentBottle = bottleMap.get(meta.bottleId);
    let isDeleted: boolean;

    if (parentBottle && parentBottle.photoIds.includes(meta.id)) {
      // ケースA: 有効な親ボトルの photoIds に属している
      isDeleted = parentBottle.deleted;
    } else {
      // ケースB: 親ボトルが存在しない、または photoIds から外された
      isDeleted = true;
    }

    let effectiveDriveFileId = meta.driveFileId;
    if (!effectiveDriveFileId && !isDeleted && knownHashToDriveId.has(meta.contentHash)) {
      effectiveDriveFileId = knownHashToDriveId.get(meta.contentHash)!;
      deduplicatedDriveFileIds[meta.id] = effectiveDriveFileId;
    }

    reconciledPhotoMetas.push({
      ...meta,
      driveFileId: effectiveDriveFileId,
      deleted: isDeleted,
    });
  }

  reconciledPhotoMetas.sort((a, b) => a.id.localeCompare(b.id));

  // 5. アップロード・ダウンロード・ローカル保持/削除の振り分け
  const photosToUpload: string[] = [];
  const photosToDownload: string[] = [];
  const photosToPurgeFromLocal: string[] = [];
  const localPhotoIdsToKeep: string[] = [];

  for (const meta of reconciledPhotoMetas) {
    const localPhoto = localPhotoMap.get(meta.id);
    const hasLocalData = Boolean(localPhoto && localPhoto.dataUrl && localPhoto.dataUrl.length > 0);

    if (!meta.deleted) {
      // 有効な写真
      if (hasLocalData) {
        localPhotoIdsToKeep.push(meta.id);
        // ローカルにあって driveFileId がまだない（かつ重複排除もできなかった）ものはアップロード対象
        if (!meta.driveFileId) {
          photosToUpload.push(meta.id);
        }
      } else {
        // ローカルにない場合は Drive からダウンロード対象（driveFileId がある場合）
        if (meta.driveFileId) {
          photosToDownload.push(meta.id);
        }
      }
    } else {
      // 削除済み写真
      if (hasLocalData) {
        // ローカルに残っている場合は物理削除対象
        photosToPurgeFromLocal.push(meta.id);
      }
    }
  }

  // ローカルに存在するが reconciledPhotoMetas に一切含まれなかった孤立写真も物理削除対象
  const reconciledIdSet = new Set(reconciledPhotoMetas.map((p) => p.id));
  for (const lp of localPhotos) {
    if (!reconciledIdSet.has(lp.id) && !photosToPurgeFromLocal.includes(lp.id)) {
      photosToPurgeFromLocal.push(lp.id);
    }
  }

  return {
    reconciledPhotoMetas,
    photosToUpload: photosToUpload.sort(),
    photosToDownload: photosToDownload.sort(),
    deduplicatedDriveFileIds,
    photosToPurgeFromLocal: photosToPurgeFromLocal.sort(),
    localPhotoIdsToKeep: localPhotoIdsToKeep.sort(),
  };
}

/** 受入確認用サンプルデータの固定 ID 集合（混入検出用） */
const SAMPLE_BOTTLE_ID_SET = new Set(SAMPLE_BOTTLES.map((b) => b.id));

/**
 * ボトル配列の中に受入確認用サンプルデータが含まれているかを判定する純粋関数
 *
 * 要件（docs/step3-4-design.md §3(3)3）:
 * - 本番 Sheet / Drive へのサンプルデータ混入を防止するため、
 *   SAMPLE_BOTTLES に含まれる固定 UUID が1件でもあれば true を返す。
 */
export function hasSampleDataRecords(bottles: BottleRecord[]): boolean {
  return bottles.some((b) => SAMPLE_BOTTLE_ID_SET.has(b.id));
}
