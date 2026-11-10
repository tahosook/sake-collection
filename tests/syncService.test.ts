import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchAutoSyncConfig,
  testSyncConnection,
  executeFullSync,
  SyncProgress,
} from '../src/services/syncService';
import {
  closeDb,
  clearDatabase,
  saveBottleWithPhotos,
  getAllBottles,
  getAllPhotos,
  getPhoto,
  saveSyncConfig,
  getSyncConfig,
  getLastSyncAt,
  loadSampleData,
  getSyncDownloadCache,
} from '../src/storage/db';
import { createNewBottle } from '../src/domain/bottleUtils';
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
  });
});
