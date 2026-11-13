import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchAutoSyncConfig,
  testSyncConnection,
  executeFullSync,
  SyncProgress,
  OFFLINE_SYNC_ERROR_MESSAGE,
  OFFLINE_CONFIG_ERROR_MESSAGE,
  OFFLINE_PING_ERROR_MESSAGE,
} from '../src/services/syncService';
import {
  closeDb,
  clearDatabase,
  saveBottleWithPhotos,
  getAllBottles,
  getAllPhotos,
  getBottle,
  getPhoto,
  deleteBottle,
  saveSyncConfig,
  getSyncConfig,
  getLastSyncAt,
  loadSampleData,
  getSyncDownloadCache,
  saveSyncDownloadCache,
  exportBackupData,
  importBackupData,
} from '../src/storage/db';
import { createNewBottle } from '../src/domain/bottleUtils';
import { validateBackupData } from '../src/domain/validation';
import { BottleRecord, PhotoRecord, SyncConnectionConfig } from '../src/types/sake';
import { SAMPLE_PHOTOS } from '../src/data/sampleData';

describe('同期クライアントサービス統合テスト (PR #13)', () => {
  const originalFetch = globalThis.fetch;

  const dummyConfig: SyncConnectionConfig = {
    gasUrl: 'https://mock-gas.local/sync',
    passphrase: 'test-secret-passphrase-123',
    source: 'manual',
    updatedAt: '2026-11-10T10:00:00.000Z',
  };

  const createTestBottle = (overrides: Partial<BottleRecord<'日本酒'>> = {}): BottleRecord => {
    const base = createNewBottle(
      {
        name: overrides.name ?? 'テスト酒',
        category: '日本酒',
        status: overrides.status ?? 'unopened',
        photoIds: overrides.photoIds ? [...overrides.photoIds] : [],
        primaryPhotoId: overrides.primaryPhotoId ?? null,
        tastingNote: overrides.tastingNote ?? '',
        wantToBuyAgain: overrides.wantToBuyAgain ?? false,
      },
      {
        id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
        nowIso: overrides.updatedAt ?? overrides.createdAt ?? '2026-11-10T10:00:00.000Z',
      }
    );

    return {
      ...base,
      ...overrides,
      createdAt: overrides.createdAt ?? base.createdAt,
      updatedAt: overrides.updatedAt ?? base.updatedAt,
      deleted: overrides.deleted ?? base.deleted,
    };
  };

  const createTestPhotoRecord = (overrides: Partial<PhotoRecord> = {}): PhotoRecord => {
    return {
      id: overrides.id ?? '11111111-0000-4000-8000-000000000001',
      bottleId: overrides.bottleId ?? '00000000-0000-4000-8000-000000000001',
      mimeType: overrides.mimeType ?? 'image/jpeg',
      dataUrl: overrides.dataUrl ?? SAMPLE_PHOTOS[0]!.dataUrl,
      width: overrides.width ?? 400,
      height: overrides.height ?? 500,
      byteSize: overrides.byteSize ?? 1024,
      contentHash: overrides.contentHash ?? '5b5fb70ef1caa9e30dc86acc6ace2cc51950471127e5e8f40b86e578de09da3d',
      driveFileId: overrides.driveFileId ?? null,
      createdAt: overrides.createdAt ?? '2026-11-10T10:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-11-10T10:00:00.000Z',
      deleted: overrides.deleted ?? false,
    };
  };

  beforeEach(async () => {
    closeDb();
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    closeDb();
    await clearDatabase();
    globalThis.fetch = originalFetch;
  });

  describe('fetchAutoSyncConfig (Pages Functions 設定自動取得)', () => {
    it('正常系: /api/sync-config から設定を取得し、IndexedDB に保存すること', () => {
      return new Promise<void>((resolve, reject) => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            gasUrl: 'https://mock-gas.local/auto-sync',
            passphrase: 'auto-passphrase-xyz',
          }),
        } as unknown as Response);

        fetchAutoSyncConfig()
          .then(async (res) => {
            expect(res.success).toBe(true);
            expect(res.config?.gasUrl).toBe('https://mock-gas.local/auto-sync');
            expect(res.config?.source).toBe('auto');

            const saved = await getSyncConfig();
            expect(saved?.gasUrl).toBe('https://mock-gas.local/auto-sync');
            expect(saved?.passphrase).toBe('auto-passphrase-xyz');
            resolve();
          })
          .catch(reject);
      });
    });

    it('403 Forbidden の場合は日本語エラーを返すこと', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      } as unknown as Response);

      const res = await fetchAutoSyncConfig();
      expect(res.success).toBe(false);
      expect(res.error).toContain('Cloudflare Access の認証が必要です');
    });
  });

  describe('testSyncConnection (ping 疎通確認)', () => {
    it('正常系: ping が成功しサーバー件数と lastSyncedAt を取得できること', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          appIdentifier: 'sake-collection',
          serverTime: '2026-11-10T12:00:00.000Z',
          counts: {
            bottlesTotal: 10,
            bottlesActive: 8,
            photosTotal: 15,
            photosActive: 12,
          },
          lastSyncedAt: '2026-11-09T18:00:00.000Z',
        }),
      } as unknown as Response);

      const res = await testSyncConnection(dummyConfig);
      expect(res.success).toBe(true);
      expect(res.response?.appIdentifier).toBe('sake-collection');
      expect(res.response?.counts?.bottlesActive).toBe(8);
    });

    it('appIdentifier 不一致のときはエラーを返すこと', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          appIdentifier: 'other-app',
        }),
      } as unknown as Response);

      const res = await testSyncConnection(dummyConfig);
      expect(res.success).toBe(false);
      expect(res.error).toContain('sake-collection 用ではありません');
    });
  });

  describe('executeFullSync (4フェーズ同期オーケストレーター)', () => {
    it('サンプルデータ混入防止ガード: サンプルデータが存在する場合は同期実行をブロックすること', async () => {
      await loadSampleData();

      await expect(executeFullSync({ config: dummyConfig })).rejects.toThrow(
        'サンプルデータが読み込まれています。『全データを削除して初期化』してから同期してください'
      );
    });

    it('設定未登録ガード: 同期設定がない場合はエラーとなること', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(executeFullSync()).rejects.toThrow(
        '同期設定（GAS URL・合言葉）が未設定です'
      );
    });

    it('空端末からの初回復元: サーバーからボトルと写真をダウンロードし完全復元すること', async () => {
      await saveSyncConfig(dummyConfig);

      const remoteBottle = createTestBottle({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'サーバー上の酒',
        photoIds: ['11111111-0000-4000-8000-000000000001'],
      });
      const remotePhoto = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000001',
        bottleId: remoteBottle.id,
        driveFileId: 'drive-remote-photo-1',
      });

      // fetch モック (Phase 1: sync_metadata, Phase 3: download_photos)
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string };

        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [remoteBottle],
              photoMetas: [
                {
                  id: remotePhoto.id,
                  bottleId: remotePhoto.bottleId,
                  mimeType: remotePhoto.mimeType,
                  width: remotePhoto.width,
                  height: remotePhoto.height,
                  byteSize: remotePhoto.byteSize,
                  contentHash: remotePhoto.contentHash,
                  driveFileId: remotePhoto.driveFileId,
                  createdAt: remotePhoto.createdAt,
                  updatedAt: remotePhoto.updatedAt,
                  deleted: false,
                },
              ],
              photosToUpload: [],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }

        if (body.action === 'download_photos') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              photos: [remotePhoto],
            }),
          } as Response);
        }

        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const progressSteps: string[] = [];
      const res = await executeFullSync({
        config: dummyConfig,
        onProgress: (p: SyncProgress) => progressSteps.push(p.step),
      });

      expect(res.success).toBe(true);
      expect(res.downloadedCount).toBe(1);
      expect(res.uploadedCount).toBe(0);

      // IndexedDB に復元されたか検証
      const localBottles = await getAllBottles(true);
      expect(localBottles).toHaveLength(1);
      expect(localBottles[0]!.name).toBe('サーバー上の酒');

      const localPhotos = await getAllPhotos();
      expect(localPhotos).toHaveLength(1);
      expect(localPhotos[0]!.driveFileId).toBe('drive-remote-photo-1');
      expect(localPhotos[0]!.dataUrl).toBe(remotePhoto.dataUrl);

      // lastSyncAt が更新されたこと
      const lastSync = await getLastSyncAt();
      expect(lastSync).toBe('2026-11-10T12:00:00.000Z');

      // 進捗ステップが順序正しく進行したこと
      expect(progressSteps).toContain('phase1_metadata');
      expect(progressSteps).toContain('phase3_download');
      expect(progressSteps).toContain('phase4_commit');
      expect(progressSteps).toContain('completed');
    });

    it('写真アップロードと即時 driveFileId 保存 (Phase 2): アップロード成功ごとに即時保存されること', async () => {
      await saveSyncConfig(dummyConfig);

      const b1 = createTestBottle({
        id: '00000000-0000-4000-8000-000000000001',
        photoIds: ['11111111-0000-4000-8000-000000000001'],
      });
      const p1 = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000001',
        bottleId: b1.id,
        driveFileId: null, // 未アップロード
      });

      await saveBottleWithPhotos(b1, [p1]);

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string };

        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [b1],
              photoMetas: [
                {
                  id: p1.id,
                  bottleId: p1.bottleId,
                  mimeType: p1.mimeType,
                  width: p1.width,
                  height: p1.height,
                  byteSize: p1.byteSize,
                  contentHash: p1.contentHash,
                  driveFileId: null,
                  createdAt: p1.createdAt,
                  updatedAt: p1.updatedAt,
                  deleted: false,
                },
              ],
              photosToUpload: [p1.id],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }

        if (body.action === 'upload_photo') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              photoId: p1.id,
              driveFileId: 'drive-uploaded-id-999',
              deduplicated: false,
            }),
          } as Response);
        }

        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const res = await executeFullSync({ config: dummyConfig });
      expect(res.success).toBe(true);
      expect(res.uploadedCount).toBe(1);

      // ローカルの写真の driveFileId が保存されていること
      const savedPhoto = await getPhoto(p1.id);
      expect(savedPhoto?.driveFileId).toBe('drive-uploaded-id-999');
    });

    it('ダウンロードのレジューム: 一時キャッシュがある場合、残りの写真のみダウンロードすること', async () => {
      await saveSyncConfig(dummyConfig);

      const b1 = createTestBottle({
        id: '00000000-0000-4000-8000-000000000001',
        photoIds: ['11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000002'],
      });

      const p1Cached = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000001',
        bottleId: b1.id,
        driveFileId: 'drive-cached-1',
      });
      const p2Pending = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000002',
        bottleId: b1.id,
        driveFileId: 'drive-pending-2',
      });

      // 前回の途中実行で p1Cached がすでにキャッシュされている状態を模擬
      const { saveSyncDownloadCache } = await import('../src/storage/db');
      await saveSyncDownloadCache([p1Cached]);

      const downloadedPhotoIds: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string; photoIds?: string[] };

        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [b1],
              photoMetas: [
                { ...p1Cached, dataUrl: undefined },
                { ...p2Pending, dataUrl: undefined },
              ],
              photosToUpload: [],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }

        if (body.action === 'download_photos') {
          if (body.photoIds) {
            downloadedPhotoIds.push(...body.photoIds);
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              photos: [p2Pending],
            }),
          } as Response);
        }

        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const res = await executeFullSync({ config: dummyConfig });
      expect(res.success).toBe(true);

      // p1Cached はキャッシュにあったためダウンロード要求されず、p2Pending のみ要求されたこと
      expect(downloadedPhotoIds).toEqual(['11111111-0000-4000-8000-000000000002']);

      // 確定コミット後、キャッシュは消去されていること
      const cacheAfter = await getSyncDownloadCache();
      expect(cacheAfter).toHaveLength(0);

      // ローカル photos に両方の写真が保存されていること
      const photosInDb = await getAllPhotos();
      expect(photosInDb).toHaveLength(2);
    });

    it('キャッシュ検証: 今回の photosToDownload に含まれない古いキャッシュは確定に混ざらず破棄されること', async () => {
      await saveSyncConfig(dummyConfig);

      const b1 = createTestBottle({
        id: '00000000-0000-4000-8000-000000000001',
        photoIds: ['11111111-0000-4000-8000-000000000001'],
      });

      const p1Target = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000001',
        bottleId: b1.id,
        driveFileId: 'drive-target-1',
      });

      // 前回の失敗等でキャッシュに残った、今回の同期対象外の写真（リモートで削除されたか別ボトル）
      const pOldOrphan = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000099',
        bottleId: '00000000-0000-4000-8000-000000000099',
        driveFileId: 'drive-orphan-99',
        contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });

      await saveSyncDownloadCache([pOldOrphan]);

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string; photoIds?: string[] };

        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [b1],
              photoMetas: [{ ...p1Target, dataUrl: undefined }],
              photosToUpload: [],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }

        if (body.action === 'download_photos') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              photos: [p1Target],
            }),
          } as Response);
        }

        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const res = await executeFullSync({ config: dummyConfig });
      expect(res.success).toBe(true);

      // p1Target のみが photos ストアに保存され、pOldOrphan は混入しないこと
      const photosInDb = await getAllPhotos(true);
      expect(photosInDb).toHaveLength(1);
      expect(photosInDb[0]?.id).toBe(p1Target.id);

      // キャッシュはクリアされていること
      const cacheAfter = await getSyncDownloadCache();
      expect(cacheAfter).toHaveLength(0);
    });

    it('キャッシュ検証: contentHash / bottleId / driveFileId が不一致のキャッシュは破棄され再ダウンロードされること', async () => {
      await saveSyncConfig(dummyConfig);

      const b1 = createTestBottle({
        id: '00000000-0000-4000-8000-000000000001',
        photoIds: ['11111111-0000-4000-8000-000000000001'],
      });

      // キャッシュにある古い写真（古い contentHash と古い dataUrl）
      const p1StaleCache = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000001',
        bottleId: b1.id,
        driveFileId: 'drive-target-1',
        contentHash: '0000000000000000000000000000000000000000000000000000000000000001',
        dataUrl: 'data:image/jpeg;base64,c3RhbGU=',
      });

      // リモートの最新写真メタデータ（新しい contentHash）
      const p1FreshMeta = {
        ...p1StaleCache,
        contentHash: '0000000000000000000000000000000000000000000000000000000000000002',
        dataUrl: undefined,
      };

      // リモートからダウンロードされる最新写真
      const p1FreshPhoto = {
        ...p1StaleCache,
        contentHash: p1FreshMeta.contentHash,
        dataUrl: 'data:image/jpeg;base64,ZnJlc2g=',
      };

      await saveSyncDownloadCache([p1StaleCache]);

      const requestedDownloadIds: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string; photoIds?: string[] };

        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [b1],
              photoMetas: [p1FreshMeta],
              photosToUpload: [],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }

        if (body.action === 'download_photos') {
          if (body.photoIds) {
            requestedDownloadIds.push(...body.photoIds);
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              photos: [p1FreshPhoto],
            }),
          } as Response);
        }

        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const res = await executeFullSync({ config: dummyConfig });
      expect(res.success).toBe(true);

      // 古いキャッシュは再利用されず、GAS にダウンロード要求されたこと
      expect(requestedDownloadIds).toEqual([p1StaleCache.id]);

      // DB に保存された写真は最新のものであること
      const savedPhoto = await getPhoto(p1StaleCache.id);
      expect(savedPhoto?.contentHash).toBe(p1FreshMeta.contentHash);
      expect(savedPhoto?.dataUrl).toBe('data:image/jpeg;base64,ZnJlc2g=');
    });
  });

  describe('削除済みボトルとバックアップ復元整合性 (監査指摘 1-1 Must)', () => {
    it('不具合再現シーケンス: 写真付きボトル登録 → 同期 → 削除 → 再同期 → バックアップ書き出し → 復元が完全に成功すること', async () => {
      await saveSyncConfig(dummyConfig);

      // 1. 写真付きボトル登録
      const bottleId = '00000000-0000-4000-8000-000000000001';
      const photoId = '11111111-0000-4000-8000-000000000001';
      const b1 = createTestBottle({
        id: bottleId,
        name: '消される酒',
        photoIds: [photoId],
        primaryPhotoId: photoId,
      });
      const p1 = createTestPhotoRecord({
        id: photoId,
        bottleId: b1.id,
        driveFileId: null, // 未同期
      });
      await saveBottleWithPhotos(b1, [p1]);

      // 2. 初回同期 (Phase 1: メタデータ同期, Phase 2: 写真アップロード)
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string };
        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [b1],
              photoMetas: [
                {
                  id: p1.id,
                  bottleId: p1.bottleId,
                  mimeType: p1.mimeType,
                  width: p1.width,
                  height: p1.height,
                  byteSize: p1.byteSize,
                  contentHash: p1.contentHash,
                  driveFileId: null,
                  createdAt: p1.createdAt,
                  updatedAt: p1.updatedAt,
                  deleted: false,
                },
              ],
              photosToUpload: [p1.id],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }
        if (body.action === 'upload_photo') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              photoId: p1.id,
              driveFileId: 'drive-synced-p1',
              deduplicated: false,
            }),
          } as Response);
        }
        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const syncRes1 = await executeFullSync({ config: dummyConfig });
      expect(syncRes1.success).toBe(true);
      expect(syncRes1.uploadedCount).toBe(1);

      // 初回同期完了の確認: driveFileId が確定していること
      const p1Synced = await getPhoto(photoId);
      expect(p1Synced?.driveFileId).toBe('drive-synced-p1');

      // 3. ボトルを論理削除
      const deleteTime = '2026-11-10T13:00:00.000Z';
      await deleteBottle(bottleId, deleteTime);

      // 削除直後の確認
      const b1Deleted = await getBottle(bottleId);
      expect(b1Deleted?.deleted).toBe(true);
      expect(b1Deleted?.photoIds).toEqual([]); // photoIds はクリアされる
      expect(await getPhoto(photoId)).toBeUndefined(); // ローカルからは即時物理削除

      // 4. 2回目の同期 (削除状態の伝播と同期確定)
      const remoteDeletedBottle = {
        ...b1,
        deleted: true,
        updatedAt: deleteTime,
        photoIds: [],
        primaryPhotoId: null,
      };
      const remoteDeletedPhotoMeta = {
        id: p1.id,
        bottleId: b1.id,
        mimeType: p1.mimeType,
        width: p1.width,
        height: p1.height,
        byteSize: p1.byteSize,
        contentHash: p1.contentHash,
        driveFileId: 'drive-synced-p1',
        createdAt: p1.createdAt,
        updatedAt: deleteTime,
        deleted: true,
      };

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string };
        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [remoteDeletedBottle],
              photoMetas: [remoteDeletedPhotoMeta],
              photosToUpload: [],
              syncedAt: '2026-11-10T14:00:00.000Z',
            }),
          } as Response);
        }
        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const syncRes2 = await executeFullSync({ config: dummyConfig });
      expect(syncRes2.success).toBe(true);

      // 5. バックアップ書き出し
      const backup = await exportBackupData();
      expect(backup.bottles).toHaveLength(1);
      expect(backup.bottles[0]?.deleted).toBe(true);
      expect(backup.bottles[0]?.photoIds).toEqual([]);
      expect(backup.photos).toHaveLength(0);

      // 6. バックアップ厳格検証 (validateBackupData) -> 成功すること！
      const valRes = validateBackupData(backup);
      expect(valRes.success).toBe(true);

      // 7. データベースをクリアして復元実行
      await clearDatabase();
      expect(await getAllBottles(true)).toHaveLength(0);

      const importRes = await importBackupData(backup);
      expect(importRes.success).toBe(true);

      // 8. 復元後の検証
      const restored = await getAllBottles(true);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.id).toBe(bottleId);
      expect(restored[0]?.deleted).toBe(true);
      expect(restored[0]?.photoIds).toEqual([]);
      expect(restored[0]?.primaryPhotoId).toBeNull();
    });

    it('他端末から旧形式の削除済みボトル (photoIds が残っている) が流入した場合でも、同期コミットで正規化されバックアップ検証が通ること', async () => {
      await saveSyncConfig(dummyConfig);

      const legacyDeletedBottle = createTestBottle({
        id: '00000000-0000-4000-8000-000000000099',
        name: '他端末の旧削除酒',
        deleted: true,
        photoIds: ['11111111-0000-4000-8000-000000000099'],
        primaryPhotoId: '11111111-0000-4000-8000-000000000099',
      });

      const legacyDeletedPhotoMeta = {
        id: '11111111-0000-4000-8000-000000000099',
        bottleId: legacyDeletedBottle.id,
        mimeType: 'image/jpeg',
        width: 400,
        height: 500,
        byteSize: 1024,
        contentHash: 'hash-legacy-99',
        driveFileId: 'drive-legacy-99',
        createdAt: '2026-11-09T10:00:00.000Z',
        updatedAt: '2026-11-09T12:00:00.000Z',
        deleted: true,
      };

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string };
        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [legacyDeletedBottle],
              photoMetas: [legacyDeletedPhotoMeta],
              photosToUpload: [],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }
        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      const res = await executeFullSync({ config: dummyConfig });
      expect(res.success).toBe(true);

      // ローカル DB に保存されたボトルは正規化されていること
      const localBottle = await getBottle(legacyDeletedBottle.id);
      expect(localBottle?.deleted).toBe(true);
      expect(localBottle?.photoIds).toEqual([]);
      expect(localBottle?.primaryPhotoId).toBeNull();

      // バックアップ書き出しと厳格検証が成功すること
      const backup = await exportBackupData();
      const valRes = validateBackupData(backup);
      expect(valRes.success).toBe(true);
    });

    it('空端末保護: サーバー上に削除済みボトルと有効ボトルが存在する場合、空端末への初回復元後にバックアップ検証が通ること', async () => {
      await saveSyncConfig(dummyConfig);

      // 有効なボトルと写真
      const activeBottle = createTestBottle({
        id: '00000000-0000-4000-8000-000000000001',
        name: '有効な酒',
        photoIds: ['11111111-0000-4000-8000-000000000001'],
        primaryPhotoId: '11111111-0000-4000-8000-000000000001',
      });
      const activePhoto = createTestPhotoRecord({
        id: '11111111-0000-4000-8000-000000000001',
        bottleId: activeBottle.id,
        driveFileId: 'drive-active-photo-1',
      });

      // 削除済みボトル（旧形式で photoIds が残っているサーバーデータ）
      const deletedBottle = createTestBottle({
        id: '00000000-0000-4000-8000-000000000002',
        name: '削除済み酒',
        deleted: true,
        photoIds: ['11111111-0000-4000-8000-000000000002'],
        primaryPhotoId: '11111111-0000-4000-8000-000000000002',
      });
      const deletedPhotoMeta = {
        id: '11111111-0000-4000-8000-000000000002',
        bottleId: deletedBottle.id,
        mimeType: 'image/jpeg',
        width: 400,
        height: 500,
        byteSize: 1024,
        contentHash: 'hash-del-2',
        driveFileId: 'drive-del-2',
        createdAt: '2026-11-09T10:00:00.000Z',
        updatedAt: '2026-11-09T12:00:00.000Z',
        deleted: true,
      };

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { action: string };
        if (body.action === 'sync_metadata') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              bottles: [activeBottle, deletedBottle],
              photoMetas: [
                {
                  id: activePhoto.id,
                  bottleId: activePhoto.bottleId,
                  mimeType: activePhoto.mimeType,
                  width: activePhoto.width,
                  height: activePhoto.height,
                  byteSize: activePhoto.byteSize,
                  contentHash: activePhoto.contentHash,
                  driveFileId: activePhoto.driveFileId,
                  createdAt: activePhoto.createdAt,
                  updatedAt: activePhoto.updatedAt,
                  deleted: false,
                },
                deletedPhotoMeta,
              ],
              photosToUpload: [],
              syncedAt: '2026-11-10T12:00:00.000Z',
            }),
          } as Response);
        }
        if (body.action === 'download_photos') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              photos: [activePhoto], // 有効な写真のみダウンロードされる
            }),
          } as Response);
        }
        return Promise.reject(new Error(`Unexpected action: ${body.action}`));
      });

      // 空端末から初回復元を実行
      const res = await executeFullSync({ config: dummyConfig });
      expect(res.success).toBe(true);
      expect(res.downloadedCount).toBe(1);

      // 有効なボトルは写真参照を維持し、削除済みボトルは正規化されていること
      const localActive = await getBottle(activeBottle.id);
      expect(localActive?.deleted).toBe(false);
      expect(localActive?.photoIds).toEqual(['11111111-0000-4000-8000-000000000001']);

      const localDeleted = await getBottle(deletedBottle.id);
      expect(localDeleted?.deleted).toBe(true);
      expect(localDeleted?.photoIds).toEqual([]);
      expect(localDeleted?.primaryPhotoId).toBeNull();

      // バックアップ書き出しと厳格検証が通ること
      const backup = await exportBackupData();
      const valRes = validateBackupData(backup);
      expect(valRes.success).toBe(true);
      expect(backup.bottles).toHaveLength(2);
      expect(backup.photos).toHaveLength(1);
    });
  });

  describe('オフライン／通信エラー時の日本語エラーメッセージ (PWA PR 2)', () => {
    it('fetchAutoSyncConfig: 通信失敗時 (TypeError) はオフライン用日本語メッセージを返すこと', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const res = await fetchAutoSyncConfig();
      expect(res.success).toBe(false);
      expect(res.error).toBe(OFFLINE_CONFIG_ERROR_MESSAGE);
    });

    it('testSyncConnection: 通信失敗時 (TypeError) はオフライン用日本語メッセージを返すこと', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Load failed'));

      const res = await testSyncConnection(dummyConfig);
      expect(res.success).toBe(false);
      expect(res.error).toBe(OFFLINE_PING_ERROR_MESSAGE);
    });

    it('executeFullSync: 設定保存済みの状態で通信失敗時、オフライン用日本語エラーを返すこと', async () => {
      await saveSyncConfig(dummyConfig);
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const progressEvents: SyncProgress[] = [];
      await expect(
        executeFullSync({
          config: dummyConfig,
          onProgress: (p) => progressEvents.push(p),
        })
      ).rejects.toThrow(OFFLINE_SYNC_ERROR_MESSAGE);

      expect(progressEvents.some((p) => p.step === 'error' && p.message === OFFLINE_SYNC_ERROR_MESSAGE)).toBe(
        true
      );
    });

    it('executeFullSync: 設定未取得の端末がオフラインのとき「未設定です」ではなくオフライン用日本語エラーを返すこと', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(executeFullSync()).rejects.toThrow(OFFLINE_SYNC_ERROR_MESSAGE);
    });
  });
});
