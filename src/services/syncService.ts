/**
 * sake-collection 同期クライアントサービス (Sync Orchestrator)
 *
 * 設計: docs/step3-4-design.md §3, §4
 * 役割:
 * - /api/sync-config からの接続設定自動取得とローカル meta ストア保存
 * - GAS バックエンドとの通信 (ping / sync_metadata / upload_photo / download_photos)
 * - サンプルデータ混入防止ガードと空端末保護
 * - 4フェーズ同期の順次実行:
 *   Phase 1: メタデータ LWW マージ・写真双方向正規化
 *   Phase 2: 写真分割アップロード (1枚ずつ、driveFileId 即時保存によるレジューム)
 *   Phase 3: 写真分割ダウンロード (最大3枚チャンク、syncDownloadCache によるレジューム)
 *   Phase 4: 単一トランザクションによるアトミック確定コミット
 */

import {
  PhotoRecord,
  PhotoSyncMeta,
  SyncConnectionConfig,
  SyncMetadataRequest,
  SyncMetadataResponse,
  UploadPhotoRequest,
  UploadPhotoResponse,
  DownloadPhotosRequest,
  DownloadPhotosResponse,
} from '../types/sake';
import {
  getAllBottles,
  getAllPhotos,
  getPhoto,
  getPendingDeletedPhotos,
  updatePhotoDriveFileId,
  getSyncDownloadCache,
  saveSyncDownloadCache,
  setSyncDownloadCache,
  commitSyncResultToDb,
  getSyncConfig,
  saveSyncConfig,
  getMeta,
} from '../storage/db';
import {
  reconcilePhotosWithBottles,
  hasSampleDataRecords,
  toPhotoSyncMeta,
} from '../domain/syncMerge';
import { validatePhotoRecord } from '../domain/validation';

export type SyncStep =
  | 'idle'
  | 'resolving_config'
  | 'checking_guards'
  | 'phase1_metadata'
  | 'phase2_upload'
  | 'phase3_download'
  | 'phase4_commit'
  | 'completed'
  | 'error';

export interface SyncProgress {
  step: SyncStep;
  message: string;
  current?: number;
  total?: number;
}

export interface PingResponse {
  ok: boolean;
  appIdentifier?: string;
  serverTime?: string;
  counts?: {
    bottlesTotal: number;
    bottlesActive: number;
    photosTotal: number;
    photosActive: number;
  };
  lastSyncedAt?: string | null;
  error?: string;
  errorCode?: string;
  message?: string;
}

export interface SyncResult {
  success: boolean;
  syncedAt: string;
  uploadedCount: number;
  downloadedCount: number;
  error?: string;
}

/**
 * Cloudflare Pages Functions (/api/sync-config) から同期設定を自動取得する
 */
export async function fetchAutoSyncConfig(): Promise<{
  success: boolean;
  config?: SyncConnectionConfig;
  error?: string;
}> {
  try {
    const res = await fetch('/api/sync-config', {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        'Cache-Control': 'no-store',
      },
    });

    if (res.status === 403) {
      return {
        success: false,
        error: 'Cloudflare Access の認証が必要です。ログイン画面からアクセスしてください。',
      };
    }

    if (!res.ok) {
      return {
        success: false,
        error: `サーバーから同期設定を取得できませんでした (HTTP ${res.status})`,
      };
    }

    const data = (await res.json()) as { ok?: boolean; gasUrl?: string; passphrase?: string; error?: string };
    if (!data.ok || !data.gasUrl || !data.passphrase) {
      return {
        success: false,
        error: data.error || '同期設定がサーバーに設定されていません',
      };
    }

    const config: SyncConnectionConfig = {
      gasUrl: data.gasUrl,
      passphrase: data.passphrase,
      source: 'auto',
      updatedAt: new Date().toISOString(),
    };

    await saveSyncConfig(config);
    return { success: true, config };
  } catch (err) {
    return {
      success: false,
      error: `同期設定の取得中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * GAS Web App との通信ヘルパー (CORS プリフライト回避のため text/plain で POST)
 */
async function postToGas<TRequest, TResponse>(gasUrl: string, payload: TRequest): Promise<TResponse> {
  const res = await fetch(gasUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`GAS サーバーとの通信に失敗しました (HTTP ${res.status})`);
  }

  const data = (await res.json()) as TResponse;
  return data;
}

/**
 * GAS との疎通確認 (ping)
 */
export async function testSyncConnection(config: SyncConnectionConfig): Promise<{
  success: boolean;
  response?: PingResponse;
  error?: string;
}> {
  try {
    const res = await postToGas<{ action: string; passphrase: string }, PingResponse>(config.gasUrl, {
      action: 'ping',
      passphrase: config.passphrase,
    });

    if (!res.ok) {
      return {
        success: false,
        error: res.message || res.error || '認証に失敗しました（合言葉が違います）',
      };
    }

    if (res.appIdentifier !== 'sake-collection') {
      return {
        success: false,
        error: `指定されたサーバーは sake-collection 用ではありません (appIdentifier: ${res.appIdentifier})`,
      };
    }

    return { success: true, response: res };
  } catch (err) {
    return {
      success: false,
      error: `サーバーに接続できませんでした: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ExecuteFullSyncOptions {
  config?: SyncConnectionConfig;
  onProgress?: (progress: SyncProgress) => void;
}

/**
 * 4フェーズ同期のフル実行オーケストレーター
 */
export async function executeFullSync(options: ExecuteFullSyncOptions = {}): Promise<SyncResult> {
  const { onProgress } = options;

  const notify = (step: SyncStep, message: string, current?: number, total?: number) => {
    if (onProgress) {
      onProgress({ step, message, current, total });
    }
  };

  // 1. 同期接続設定の解決
  notify('resolving_config', '同期設定を確認中...');
  let config = options.config;
  if (!config) {
    config = (await getSyncConfig()) ?? undefined;
  }
  if (!config) {
    const autoRes = await fetchAutoSyncConfig();
    if (autoRes.success && autoRes.config) {
      config = autoRes.config;
    }
  }

  if (!config || !config.gasUrl || !config.passphrase) {
    const errMsg = '同期設定（GAS URL・合言葉）が未設定です。「同期設定」から入力してください。';
    notify('error', errMsg);
    throw new Error(errMsg);
  }

  // 2. ガード検証 (サンプルデータガード・空端末判定)
  notify('checking_guards', 'ローカルデータの状態を確認中...');
  const allBottles = await getAllBottles(true); // 論理削除含む全件
  const allPhotos = await getAllPhotos();
  const isSampleLoaded = Boolean(await getMeta<boolean>('isSampleDataLoaded'));

  if (hasSampleDataRecords(allBottles) || isSampleLoaded) {
    const errMsg = 'サンプルデータが読み込まれています。『全データを削除して初期化』してから同期してください';
    notify('error', errMsg);
    throw new Error(errMsg);
  }

  const pendingDeletedPhotos = await getPendingDeletedPhotos();
  const isInitialEmptyClient = allBottles.length === 0 && pendingDeletedPhotos.length === 0;

  // ----------------------------------------------------
  // Phase 1: メタデータ同期 (sync_metadata)
  // ----------------------------------------------------
  notify('phase1_metadata', 'ボトル情報を同期中...');
  const localPhotoMetas: PhotoSyncMeta[] = allPhotos.map(toPhotoSyncMeta);

  const metaRequest: SyncMetadataRequest = {
    action: 'sync_metadata',
    passphrase: config.passphrase,
    isInitialEmptyClient,
    bottles: allBottles,
    photoMetas: localPhotoMetas,
    pendingDeletedPhotos,
  };

  const metaResponse = await postToGas<SyncMetadataRequest, SyncMetadataResponse>(
    config.gasUrl,
    metaRequest
  );

  if (!metaResponse.ok) {
    const errMsg = metaResponse.error || 'メタデータの同期に失敗しました';
    notify('error', errMsg);
    throw new Error(errMsg);
  }

  // クライアント側ドメイン計算で双方向整合性を正規化
  const reconciled = reconcilePhotosWithBottles({
    mergedBottles: metaResponse.bottles,
    localPhotos: allPhotos,
    remotePhotoMetas: metaResponse.photoMetas,
    pendingDeletedPhotos,
  });

  // contentHash 重複排除で確定した driveFileId があればローカル IndexedDB に即時保存
  for (const [photoId, deduplicatedId] of Object.entries(reconciled.deduplicatedDriveFileIds)) {
    await updatePhotoDriveFileId(photoId, deduplicatedId, metaResponse.syncedAt);
  }

  // ----------------------------------------------------
  // Phase 2: 写真分割アップロード (1枚ずつ)
  // ----------------------------------------------------
  const photosToUpload = reconciled.photosToUpload;
  let uploadedCount = 0;

  if (photosToUpload.length > 0) {
    notify('phase2_upload', `写真を送信中 (0/${photosToUpload.length})...`, 0, photosToUpload.length);

    for (let i = 0; i < photosToUpload.length; i++) {
      const pid = photosToUpload[i];
      if (!pid) continue;

      const photoRecord = await getPhoto(pid);
      if (!photoRecord) {
        continue;
      }

      // 重複排除等で既に driveFileId が確定している場合はアップロード不要
      if (photoRecord.driveFileId) {
        continue;
      }

      const uploadReq: UploadPhotoRequest = {
        action: 'upload_photo',
        passphrase: config.passphrase,
        photo: photoRecord,
      };

      const uploadRes = await postToGas<UploadPhotoRequest, UploadPhotoResponse>(
        config.gasUrl,
        uploadReq
      );

      if (!uploadRes.ok || !uploadRes.driveFileId) {
        const errMsg = uploadRes.error || `写真 (${pid}) のアップロードに失敗しました`;
        notify('error', errMsg);
        throw new Error(errMsg);
      }

      // 1枚成功するごとにローカル IndexedDB に即時保存 (レジューム対応)
      await updatePhotoDriveFileId(pid, uploadRes.driveFileId);
      uploadedCount++;

      notify(
        'phase2_upload',
        `写真を送信中 (${i + 1}/${photosToUpload.length})...`,
        i + 1,
        photosToUpload.length
      );
    }
  }

  // ----------------------------------------------------
  // Phase 3: 写真分割ダウンロード (最大3枚チャンク)
  // ----------------------------------------------------
  const photosToDownload = reconciled.photosToDownload;
  let downloadedCount = 0;

  // リモートメタデータマップ (contentHash, bottleId, driveFileId 照合用)
  const remoteMetaMap = new Map<string, PhotoSyncMeta>(
    metaResponse.photoMetas.map((m) => [m.id, m])
  );

  // 既存のダウンロードキャッシュ (途中失敗時のレジューム用) の精査
  const cachedPhotos = await getSyncDownloadCache();
  const validCachedPhotoMap = new Map<string, PhotoRecord>();
  let hasDiscardedCache = false;

  const photosToDownloadSet = new Set(photosToDownload);

  for (const cp of cachedPhotos) {
    const meta = remoteMetaMap.get(cp.id);
    const isTarget = photosToDownloadSet.has(cp.id);
    const isMetaMatch =
      meta !== undefined &&
      meta.contentHash === cp.contentHash &&
      meta.bottleId === cp.bottleId &&
      meta.driveFileId === cp.driveFileId;

    if (isTarget && isMetaMatch) {
      validCachedPhotoMap.set(cp.id, cp);
    } else {
      // 今回のダウンロード対象外、または contentHash / bottleId / driveFileId が不一致のキャッシュは破棄
      hasDiscardedCache = true;
    }
  }

  // 不一致・不要なキャッシュが存在した場合はキャッシュストアを健全化
  if (hasDiscardedCache) {
    await setSyncDownloadCache(Array.from(validCachedPhotoMap.values()));
  }

  // まだダウンロードしていない写真 ID (キャッシュ不一致で破棄されたものを含む)
  const pendingDownloadIds = photosToDownload.filter((id) => !validCachedPhotoMap.has(id));

  if (photosToDownload.length > 0) {
    const alreadyCachedCount = photosToDownload.length - pendingDownloadIds.length;
    downloadedCount = alreadyCachedCount;

    notify(
      'phase3_download',
      `写真を受信中 (${downloadedCount}/${photosToDownload.length})...`,
      downloadedCount,
      photosToDownload.length
    );

    const CHUNK_SIZE = 3;
    for (let i = 0; i < pendingDownloadIds.length; i += CHUNK_SIZE) {
      const chunkIds = pendingDownloadIds.slice(i, i + CHUNK_SIZE);

      const downloadReq: DownloadPhotosRequest = {
        action: 'download_photos',
        passphrase: config.passphrase,
        photoIds: chunkIds,
      };

      const downloadRes = await postToGas<DownloadPhotosRequest, DownloadPhotosResponse>(
        config.gasUrl,
        downloadReq
      );

      if (!downloadRes.ok || !Array.isArray(downloadRes.photos)) {
        const errMsg = downloadRes.error || '写真のダウンロードに失敗しました';
        notify('error', errMsg);
        throw new Error(errMsg);
      }

      // 受信した写真の厳密検証
      const validatedPhotos: PhotoRecord[] = [];
      for (const p of downloadRes.photos) {
        const valRes = validatePhotoRecord(p);
        if (!valRes.success) {
          const errMsg = `受信した写真レコードが不正です: ${valRes.error}`;
          notify('error', errMsg);
          throw new Error(errMsg);
        }
        validatedPhotos.push(valRes.data);
        validCachedPhotoMap.set(valRes.data.id, valRes.data);
      }

      // チャンク成功ごとにキャッシュへ保存 (レジューム用)
      await saveSyncDownloadCache(validatedPhotos);
      downloadedCount += validatedPhotos.length;

      notify(
        'phase3_download',
        `写真を受信中 (${downloadedCount}/${photosToDownload.length})...`,
        downloadedCount,
        photosToDownload.length
      );
    }
  }

  // ----------------------------------------------------
  // Phase 4: 単一トランザクションで確定コミット
  // ----------------------------------------------------
  notify('phase4_commit', 'データを確定中...');

  // 確定対象は今回の photosToDownload に含まれる写真だけに絞る
  const finalPhotosToUpsert: PhotoRecord[] = [];
  for (const pid of photosToDownload) {
    const photo = validCachedPhotoMap.get(pid);
    if (!photo) {
      const errMsg = `不足写真のダウンロードが不完全です (photoId: ${pid})`;
      notify('error', errMsg);
      throw new Error(errMsg);
    }
    finalPhotosToUpsert.push(photo);
  }


  await commitSyncResultToDb({
    bottles: metaResponse.bottles,
    photosToPurge: reconciled.photosToPurgeFromLocal,
    photosToUpsert: finalPhotosToUpsert,
    syncedAtIso: metaResponse.syncedAt,
  });

  notify('completed', '同期が完了しました');

  return {
    success: true,
    syncedAt: metaResponse.syncedAt,
    uploadedCount,
    downloadedCount,
  };
}
