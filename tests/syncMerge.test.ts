import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mergeBottleRecords,
  mergeBottleCollections,
  mergePhotoSyncMetas,
  reconcilePhotosWithBottles,
  hasSampleDataRecords,
} from '../src/domain/syncMerge';
import {
  closeDb,
  clearDatabase,
  saveBottleWithPhotos,
  commitSyncResultToDb,
  getPendingDeletedPhotos,
  getBottle,
  getPhoto,
  exportBackupData,
} from '../src/storage/db';
import { validateBackupData } from '../src/domain/validation';
import { createNewBottle } from '../src/domain/bottleUtils';
import { BottleRecord, PhotoRecord, PhotoSyncMeta } from '../src/types/sake';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../src/data/sampleData';

describe('同期マージ純粋ドメインロジック (PR #11)', () => {
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
        nowIso: overrides.updatedAt ?? overrides.createdAt ?? '2026-11-09T10:00:00.000Z',
      }
    );

    const bottle: BottleRecord = {
      ...base,
      ...overrides,
      createdAt: overrides.createdAt ?? base.createdAt,
      updatedAt: overrides.updatedAt ?? base.updatedAt,
      deleted: overrides.deleted ?? base.deleted,
      purchaseInfo: {
        ...base.purchaseInfo,
        ...overrides.purchaseInfo,
      },
    };

    return bottle;
  };

  const createTestPhotoMeta = (overrides: Partial<PhotoSyncMeta> = {}): PhotoSyncMeta => {
    return {
      id: overrides.id ?? '11111111-0000-4000-8000-000000000001',
      bottleId: overrides.bottleId ?? '00000000-0000-4000-8000-000000000001',
      mimeType: overrides.mimeType ?? 'image/jpeg',
      width: overrides.width ?? 400,
      height: overrides.height ?? 500,
      byteSize: overrides.byteSize ?? 1024,
      contentHash: overrides.contentHash ?? '5b5fb70ef1caa9e30dc86acc6ace2cc51950471127e5e8f40b86e578de09da3d',
      driveFileId: overrides.driveFileId ?? null,
      createdAt: overrides.createdAt ?? '2026-11-09T10:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-11-09T10:00:00.000Z',
      deleted: overrides.deleted ?? false,
    };
  };

  const createTestPhotoRecord = (overrides: Partial<PhotoRecord> = {}): PhotoRecord => {
    const meta = createTestPhotoMeta(overrides);
    return {
      ...meta,
      dataUrl: overrides.dataUrl ?? SAMPLE_PHOTOS[0]!.dataUrl,
    };
  };

  describe('mergeBottleRecords (LWW 競合解決)', () => {
    it('ローカルの updatedAt が新しい場合はローカルを採用すること', () => {
      const id = '00000000-0000-4000-8000-000000000001';
      const local = createTestBottle({ id, name: 'ローカル更新版', updatedAt: '2026-11-09T12:00:00.000Z' });
      const remote = createTestBottle({ id, name: 'リモート版', updatedAt: '2026-11-09T11:00:00.000Z' });

      const merged = mergeBottleRecords(local, remote);
      expect(merged.name).toBe('ローカル更新版');
      expect(merged.updatedAt).toBe('2026-11-09T12:00:00.000Z');
    });

    it('リモートの updatedAt が新しい場合はリモートを採用すること', () => {
      const id = '00000000-0000-4000-8000-000000000001';
      const local = createTestBottle({ id, name: 'ローカル版', updatedAt: '2026-11-09T10:00:00.000Z' });
      const remote = createTestBottle({ id, name: 'リモート最新版', updatedAt: '2026-11-09T14:00:00.000Z' });

      const merged = mergeBottleRecords(local, remote);
      expect(merged.name).toBe('リモート最新版');
      expect(merged.updatedAt).toBe('2026-11-09T14:00:00.000Z');
    });

    it('updatedAt が同一の場合、deleted === true を優先すること（削除優先タイブレーク）', () => {
      const id = '00000000-0000-4000-8000-000000000001';
      const sameTime = '2026-11-09T12:00:00.000Z';
      const active = createTestBottle({ id, name: '有効ボトル', deleted: false, updatedAt: sameTime });
      const deleted = createTestBottle({ id, name: '削除済みボトル', deleted: true, updatedAt: sameTime });

      expect(mergeBottleRecords(active, deleted).deleted).toBe(true);
      expect(mergeBottleRecords(deleted, active).deleted).toBe(true);
    });

    it('updatedAt と deleted が同一の場合、リモート側を維持すること', () => {
      const id = '00000000-0000-4000-8000-000000000001';
      const sameTime = '2026-11-09T12:00:00.000Z';
      const local = createTestBottle({ id, name: 'ローカル版', tastingNote: 'ローカルメモ', updatedAt: sameTime });
      const remote = createTestBottle({ id, name: 'リモート版', tastingNote: 'リモートメモ', updatedAt: sameTime });

      const merged = mergeBottleRecords(local, remote);
      expect(merged.name).toBe('リモート版');
      expect(merged.tastingNote).toBe('リモートメモ');
    });

    it('ID が異なるボトルを渡した場合はエラーをスローすること', () => {
      const b1 = createTestBottle({ id: '00000000-0000-4000-8000-000000000001' });
      const b2 = createTestBottle({ id: '00000000-0000-4000-8000-000000000002' });

      expect(() => mergeBottleRecords(b1, b2)).toThrow('ID が一致しないボトルはマージできません');
    });
  });

  describe('mergeBottleCollections (コレクションマージ・空端末保護・初回同期・冪等性)', () => {
    it('空端末保護: isInitialEmptyClient が true の場合、リモートの全データをそのまま復元すること', () => {
      const remoteBottles = [
        createTestBottle({ id: '00000000-0000-4000-8000-000000000001', name: '酒1' }),
        createTestBottle({ id: '00000000-0000-4000-8000-000000000002', name: '酒2' }),
      ];

      const merged = mergeBottleCollections({
        localBottles: [],
        remoteBottles,
        isInitialEmptyClient: true,
      });

      expect(merged).toHaveLength(2);
      expect(merged.map((b) => b.id)).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    });

    it('ローカルが0件の場合、isInitialEmptyClient の指定がなくてもリモートをそのまま採用すること', () => {
      const remoteBottles = [
        createTestBottle({ id: '00000000-0000-4000-8000-000000000001', name: '酒1' }),
      ];

      const merged = mergeBottleCollections({
        localBottles: [],
        remoteBottles,
      });

      expect(merged).toHaveLength(1);
      expect(merged[0]?.name).toBe('酒1');
    });

    it('初回通常同期（両方に実データあり）: ローカルとリモートの和集合がマージされること', () => {
      const bLocalOnly = createTestBottle({ id: '00000000-0000-4000-8000-000000000001', name: 'ローカルのみ酒' });
      const bRemoteOnly = createTestBottle({ id: '00000000-0000-4000-8000-000000000002', name: 'リモートのみ酒' });
      const bBothLocalNewer = createTestBottle({
        id: '00000000-0000-4000-8000-000000000003',
        name: '両方あり（ローカル最新）',
        updatedAt: '2026-11-09T15:00:00.000Z',
      });
      const bBothRemoteOlder = createTestBottle({
        id: '00000000-0000-4000-8000-000000000003',
        name: '両方あり（リモート旧）',
        updatedAt: '2026-11-09T10:00:00.000Z',
      });

      const merged = mergeBottleCollections({
        localBottles: [bLocalOnly, bBothLocalNewer],
        remoteBottles: [bRemoteOnly, bBothRemoteOlder],
      });

      expect(merged).toHaveLength(3);
      expect(merged.find((b) => b.id === bLocalOnly.id)?.name).toBe('ローカルのみ酒');
      expect(merged.find((b) => b.id === bRemoteOnly.id)?.name).toBe('リモートのみ酒');
      expect(merged.find((b) => b.id === bBothLocalNewer.id)?.name).toBe('両方あり（ローカル最新）');
    });

    it('論理削除の伝播: 一方で論理削除されたボトルが新しい updatedAt を持っていれば伝播すること', () => {
      const id = '00000000-0000-4000-8000-000000000001';
      const localActiveOld = createTestBottle({ id, deleted: false, updatedAt: '2026-11-09T10:00:00.000Z' });
      const remoteDeletedNew = createTestBottle({ id, deleted: true, updatedAt: '2026-11-09T12:00:00.000Z' });

      const merged = mergeBottleCollections({
        localBottles: [localActiveOld],
        remoteBottles: [remoteDeletedNew],
      });

      expect(merged[0]?.deleted).toBe(true);
      expect(merged[0]?.updatedAt).toBe('2026-11-09T12:00:00.000Z');
    });

    it('冪等性: 同じ同期マージを何度連続で実行しても結果が変わらないこと', () => {
      const localList = [
        createTestBottle({ id: '00000000-0000-4000-8000-000000000001', name: '酒A', updatedAt: '2026-11-09T10:00:00.000Z' }),
        createTestBottle({ id: '00000000-0000-4000-8000-000000000002', name: '酒B', updatedAt: '2026-11-09T12:00:00.000Z' }),
      ];
      const remoteList = [
        createTestBottle({ id: '00000000-0000-4000-8000-000000000001', name: '酒A（新）', updatedAt: '2026-11-09T11:00:00.000Z' }),
        createTestBottle({ id: '00000000-0000-4000-8000-000000000003', name: '酒C', updatedAt: '2026-11-09T10:00:00.000Z' }),
      ];

      const firstPass = mergeBottleCollections({ localBottles: localList, remoteBottles: remoteList });
      const secondPass = mergeBottleCollections({ localBottles: firstPass, remoteBottles: remoteList });
      const thirdPass = mergeBottleCollections({ localBottles: firstPass, remoteBottles: firstPass });

      expect(secondPass).toEqual(firstPass);
      expect(thirdPass).toEqual(firstPass);
    });
  });

  describe('mergePhotoSyncMetas', () => {
    it('LWW で新しい方を採用しつつ、既存の driveFileId を保持すること', () => {
      const id = '11111111-0000-4000-8000-000000000001';
      const localNewWithoutDrive = createTestPhotoMeta({
        id,
        driveFileId: null,
        updatedAt: '2026-11-09T14:00:00.000Z',
      });
      const remoteOldWithDrive = createTestPhotoMeta({
        id,
        driveFileId: 'drive-file-123',
        updatedAt: '2026-11-09T10:00:00.000Z',
      });

      const merged = mergePhotoSyncMetas(localNewWithoutDrive, remoteOldWithDrive);
      expect(merged.updatedAt).toBe('2026-11-09T14:00:00.000Z');
      expect(merged.driveFileId).toBe('drive-file-123'); // 既存の driveFileId が引き継がれる
    });
  });

  describe('reconcilePhotosWithBottles (双方向整合・contentHash 重複排除・アップロード/ダウンロード/物理削除判定)', () => {
    it('親ボトルの photoIds による正規化: 属する写真はボトルの deleted に従い、外された写真は deleted = true になること', () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const p1Id = '11111111-0000-4000-8000-000000000001';
      const pRemovedId = '11111111-0000-4000-8000-000000000002';

      // ボトル b1 は p1Id のみを保持しており、pRemovedId は photoIds から外されている
      const b1 = createTestBottle({ id: b1Id, photoIds: [p1Id], deleted: false });

      const p1 = createTestPhotoRecord({ id: p1Id, bottleId: b1Id, driveFileId: 'drive-1' });
      const pRemoved = createTestPhotoRecord({ id: pRemovedId, bottleId: b1Id, driveFileId: 'drive-2' });

      const res = reconcilePhotosWithBottles({
        mergedBottles: [b1],
        localPhotos: [p1, pRemoved],
        remotePhotoMetas: [p1, pRemoved],
      });

      const meta1 = res.reconciledPhotoMetas.find((p) => p.id === p1Id);
      const metaRemoved = res.reconciledPhotoMetas.find((p) => p.id === pRemovedId);

      expect(meta1?.deleted).toBe(false);
      expect(metaRemoved?.deleted).toBe(true); // 外されたため論理削除に正規化される
      expect(res.photosToPurgeFromLocal).toContain(pRemovedId); // ローカルからは物理削除対象になる
      expect(res.localPhotoIdsToKeep).toContain(p1Id);
    });

    it('親ボトルが deleted = true の場合、属する写真も deleted = true になること', () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const p1Id = '11111111-0000-4000-8000-000000000001';

      const b1Deleted = createTestBottle({ id: b1Id, photoIds: [p1Id], deleted: true });
      const p1 = createTestPhotoRecord({ id: p1Id, bottleId: b1Id, driveFileId: 'drive-1' });

      const res = reconcilePhotosWithBottles({
        mergedBottles: [b1Deleted],
        localPhotos: [p1],
        remotePhotoMetas: [p1],
      });

      const meta1 = res.reconciledPhotoMetas.find((p) => p.id === p1Id);
      expect(meta1?.deleted).toBe(true);
      expect(res.photosToPurgeFromLocal).toContain(p1Id);
    });

    it('contentHash による重複排除: 同一ハッシュの既存 driveFileId があれば再利用しアップロードをスキップすること', () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const b2Id = '00000000-0000-4000-8000-000000000002';
      const p1Id = '11111111-0000-4000-8000-000000000001';
      const p2Id = '11111111-0000-4000-8000-000000000002';
      const commonHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      const b1 = createTestBottle({ id: b1Id, photoIds: [p1Id] });
      const b2 = createTestBottle({ id: b2Id, photoIds: [p2Id] });

      // p1 はすでに driveFileId が確定している
      const p1Synced = createTestPhotoRecord({
        id: p1Id,
        bottleId: b1Id,
        contentHash: commonHash,
        driveFileId: 'drive-existing-123',
      });

      // p2 はローカルで新しく撮った（または流用・一括登録した）同一画像の別写真で、driveFileId がまだない
      const p2New = createTestPhotoRecord({
        id: p2Id,
        bottleId: b2Id,
        contentHash: commonHash,
        driveFileId: null,
      });

      const res = reconcilePhotosWithBottles({
        mergedBottles: [b1, b2],
        localPhotos: [p1Synced, p2New],
        remotePhotoMetas: [p1Synced],
      });

      // p2 の driveFileId が p1 のもので重複排除解決されること
      expect(res.deduplicatedDriveFileIds[p2Id]).toBe('drive-existing-123');
      const meta2 = res.reconciledPhotoMetas.find((p) => p.id === p2Id);
      expect(meta2?.driveFileId).toBe('drive-existing-123');

      // 重複排除されたため、新規アップロード対象には含まれないこと
      expect(res.photosToUpload).not.toContain(p2Id);
    });

    it('削除済み写真や親ボトルから外された写真と同じ contentHash を持つ有効な写真が driveFileId を引き継がず、新規アップロード対象になること', () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const b2Id = '00000000-0000-4000-8000-000000000002';
      const pDeletedId = '11111111-0000-4000-8000-000000000001';
      const pActiveId = '11111111-0000-4000-8000-000000000002';
      const commonHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

      // ボトル b1 は削除済み、または pDeletedId を保持していない
      const b1 = createTestBottle({ id: b1Id, photoIds: [], deleted: false });
      // ボトル b2 は有効で pActiveId を保持
      const b2 = createTestBottle({ id: b2Id, photoIds: [pActiveId], deleted: false });

      // 削除済み（または外された）写真：過去の driveFileId を持っている
      const pDeleted = createTestPhotoMeta({
        id: pDeletedId,
        bottleId: b1Id,
        contentHash: commonHash,
        driveFileId: 'drive-trashed-file-999',
        deleted: true,
      });

      // 新しい有効な写真：同一画像（同じ contentHash）だが driveFileId 未確定でローカルにデータあり
      const pActive = createTestPhotoRecord({
        id: pActiveId,
        bottleId: b2Id,
        contentHash: commonHash,
        driveFileId: null,
      });

      const res = reconcilePhotosWithBottles({
        mergedBottles: [b1, b2],
        localPhotos: [pActive],
        remotePhotoMetas: [pDeleted],
      });

      // 削除済み写真の driveFileId は引き継がれない（重複排除マップに登録されない）
      expect(res.deduplicatedDriveFileIds[pActiveId]).toBeUndefined();
      const metaActive = res.reconciledPhotoMetas.find((p) => p.id === pActiveId);
      expect(metaActive?.driveFileId).toBeNull();

      // アップロード対象として判定されること
      expect(res.photosToUpload).toContain(pActiveId);
    });

    it('ローカル写真であっても親ボトルの photoIds から外された写真の driveFileId は再利用されないこと', () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const b2Id = '00000000-0000-4000-8000-000000000002';
      const pRemovedId = '11111111-0000-4000-8000-000000000001';
      const pActiveId = '11111111-0000-4000-8000-000000000002';
      const commonHash = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';

      // b1 から pRemovedId は外されている
      const b1 = createTestBottle({ id: b1Id, photoIds: [], deleted: false });
      const b2 = createTestBottle({ id: b2Id, photoIds: [pActiveId], deleted: false });

      // ローカル photos ストアには物理的に残っているが親ボトルの photoIds から外れた写真
      const pRemovedLocal = createTestPhotoRecord({
        id: pRemovedId,
        bottleId: b1Id,
        contentHash: commonHash,
        driveFileId: 'drive-removed-file-888',
      });

      // 新しい有効な写真
      const pActive = createTestPhotoRecord({
        id: pActiveId,
        bottleId: b2Id,
        contentHash: commonHash,
        driveFileId: null,
      });

      const res = reconcilePhotosWithBottles({
        mergedBottles: [b1, b2],
        localPhotos: [pRemovedLocal, pActive],
        remotePhotoMetas: [
          createTestPhotoMeta({
            id: pRemovedId,
            bottleId: b1Id,
            contentHash: commonHash,
            driveFileId: 'drive-removed-file-888',
          }),
        ],
      });

      // 外された写真の driveFileId は引き継がれない
      expect(res.deduplicatedDriveFileIds[pActiveId]).toBeUndefined();
      const metaActive = res.reconciledPhotoMetas.find((p) => p.id === pActiveId);
      expect(metaActive?.driveFileId).toBeNull();
      expect(res.photosToUpload).toContain(pActiveId);
    });

    it('deleted: true で親ボトルの photoIds に含まれるローカル写真と同じ contentHash の有効な別写真が、driveFileId を引き継がず photosToUpload に入ること', () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const b2Id = '00000000-0000-4000-8000-000000000002';
      const pDeletedLocalId = '11111111-0000-4000-8000-000000000001';
      const pActiveId = '11111111-0000-4000-8000-000000000002';
      const commonHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      // b1 は有効で、photoIds に pDeletedLocalId が含まれている
      const b1 = createTestBottle({ id: b1Id, photoIds: [pDeletedLocalId], deleted: false });
      // b2 も有効で、photoIds に pActiveId が含まれている
      const b2 = createTestBottle({ id: b2Id, photoIds: [pActiveId], deleted: false });

      // deleted: true で親ボトルの photoIds に含まれるローカル写真
      const pDeletedLocal = createTestPhotoRecord({
        id: pDeletedLocalId,
        bottleId: b1Id,
        contentHash: commonHash,
        driveFileId: 'drive-deleted-local-777',
        deleted: true,
      });

      // 有効な別写真（同一 contentHash、driveFileId 未設定、ローカルにデータあり）
      const pActive = createTestPhotoRecord({
        id: pActiveId,
        bottleId: b2Id,
        contentHash: commonHash,
        driveFileId: null,
        deleted: false,
      });

      const res = reconcilePhotosWithBottles({
        mergedBottles: [b1, b2],
        localPhotos: [pDeletedLocal, pActive],
        remotePhotoMetas: [
          createTestPhotoMeta({
            id: pDeletedLocalId,
            bottleId: b1Id,
            contentHash: commonHash,
            driveFileId: 'drive-deleted-local-777',
            deleted: true,
          }),
        ],
      });

      // deleted: true のローカル写真の driveFileId は引き継がれない
      expect(res.deduplicatedDriveFileIds[pActiveId]).toBeUndefined();
      const metaActive = res.reconciledPhotoMetas.find((p) => p.id === pActiveId);
      expect(metaActive?.driveFileId).toBeNull();
      expect(res.photosToUpload).toContain(pActiveId);
    });

    it('アップロード要否とダウンロード要否が正確に判定されること', () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const pUploadId = '11111111-0000-4000-8000-000000000001';
      const pDownloadId = '11111111-0000-4000-8000-000000000002';

      const b1 = createTestBottle({ id: b1Id, photoIds: [pUploadId, pDownloadId] });

      // pUpload はローカルに実体があるが driveFileId がない
      const pUpload = createTestPhotoRecord({
        id: pUploadId,
        bottleId: b1Id,
        driveFileId: null,
        contentHash: 'hash-unique-111111111111111111111111111111111111111111111111111111111111',
      });

      // pDownload はリモートに存在し driveFileId があるが、ローカルにはまだない
      const pDownloadMeta = createTestPhotoMeta({
        id: pDownloadId,
        bottleId: b1Id,
        driveFileId: 'drive-remote-999',
        contentHash: 'hash-unique-222222222222222222222222222222222222222222222222222222222222',
      });

      const res = reconcilePhotosWithBottles({
        mergedBottles: [b1],
        localPhotos: [pUpload], // pDownload はローカルにない
        remotePhotoMetas: [pDownloadMeta],
      });

      expect(res.photosToUpload).toEqual([pUploadId]);
      expect(res.photosToDownload).toEqual([pDownloadId]);
      expect(res.localPhotoIdsToKeep).toContain(pUploadId);
    });
  });

  describe('hasSampleDataRecords (サンプルデータ混入検出)', () => {
    it('SAMPLE_BOTTLES のレコードが含まれている場合は true を返すこと', () => {
      const sample = SAMPLE_BOTTLES[0]!;
      expect(hasSampleDataRecords([sample])).toBe(true);

      const mixed = [
        sample,
        createTestBottle({ id: '99999999-9999-4000-8000-999999999999' }),
      ];
      expect(hasSampleDataRecords(mixed)).toBe(true);
    });

    it('通常の新規ボトルのみの場合は false を返すこと', () => {
      const userBottles = [
        createTestBottle({ id: 'aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa' }),
        createTestBottle({ id: 'bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb' }),
      ];
      expect(hasSampleDataRecords(userBottles)).toBe(false);
      expect(hasSampleDataRecords([])).toBe(false);
    });
  });

  describe('IndexedDB 永続化とバックアップ双方向整合性 (saveBottleWithPhotos & commitSyncResultToDb)', () => {
    beforeEach(async () => {
      await clearDatabase();
    });

    afterEach(() => {
      closeDb();
    });

    it('Drive同期済み写真を photoIds から外したとき、photos から物理削除され pendingDeletedPhotos に記録され、バックアップ整合性が保たれること', async () => {
      const bId = '00000000-0000-4000-8000-000000000001';
      const p1Id = '11111111-0000-4000-8000-000000000001';
      const p2Id = '11111111-0000-4000-8000-000000000002';

      // 1. 最初は2枚の写真（Drive 同期済み）を持つボトルを保存
      const initialBottle = createTestBottle({
        id: bId,
        photoIds: [p1Id, p2Id],
        primaryPhotoId: p1Id,
      });

      const p1 = createTestPhotoRecord({ id: p1Id, bottleId: bId, driveFileId: 'drive-p1' });
      const p2 = createTestPhotoRecord({ id: p2Id, bottleId: bId, driveFileId: 'drive-p2' });

      await saveBottleWithPhotos(initialBottle, [p1, p2]);

      expect(await getPhoto(p1Id)).toBeDefined();
      expect(await getPhoto(p2Id)).toBeDefined();

      // バックアップが双方向整合していることを確認
      const backupBefore = await exportBackupData();
      expect(validateBackupData(backupBefore).success).toBe(true);

      // 2. ボトルを編集し、p2Id を photoIds から外す
      const updatedBottle: BottleRecord = {
        ...initialBottle,
        photoIds: [p1Id],
        primaryPhotoId: p1Id,
        updatedAt: '2026-11-09T16:00:00.000Z',
      };

      await saveBottleWithPhotos(updatedBottle, []);

      // p2Id はローカル photos ストアから物理削除されていること
      expect(await getPhoto(p2Id)).toBeUndefined();
      expect(await getPhoto(p1Id)).toBeDefined();

      // p2Id の削除予定メタデータが pendingDeletedPhotos に記録されていること
      const pending = await getPendingDeletedPhotos();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(p2Id);
      expect(pending[0]?.deleted).toBe(true);
      expect(pending[0]?.driveFileId).toBe('drive-p2');

      // 重要: この状態で即座にバックアップをエクスポートしても、双方向整合性エラーにならないこと！
      const backupAfterRemoval = await exportBackupData();
      const valResult = validateBackupData(backupAfterRemoval);
      expect(valResult.success).toBe(true);
      // バックアップ内にも p2 は存在しないこと
      expect(backupAfterRemoval.photos.some((p) => p.id === p2Id)).toBe(false);
    });

    it('commitSyncResultToDb: 同期マージ結果をアトミック反映し、pendingDeletedPhotos をクリアして双方向整合性を保つこと', async () => {
      const b1Id = '00000000-0000-4000-8000-000000000001';
      const p1Id = '11111111-0000-4000-8000-000000000001';
      const pDownloadedId = '11111111-0000-4000-8000-000000000002';
      const pPurgeId = '11111111-0000-4000-8000-000000000003';

      // 初期状態の保存
      const oldBottle = createTestBottle({ id: b1Id, photoIds: [p1Id, pPurgeId] });
      const p1 = createTestPhotoRecord({ id: p1Id, bottleId: b1Id, driveFileId: 'drive-p1' });
      const pPurge = createTestPhotoRecord({ id: pPurgeId, bottleId: b1Id, driveFileId: 'drive-purge' });

      await saveBottleWithPhotos(oldBottle, [p1, pPurge]);

      // 同期結果コミット:
      // ボトルは p1Id と新しくダウンロードした pDownloadedId を参照するように更新
      const syncedBottle = createTestBottle({
        id: b1Id,
        photoIds: [p1Id, pDownloadedId],
        primaryPhotoId: p1Id,
        updatedAt: '2026-11-09T18:00:00.000Z',
      });

      const pDownloaded = createTestPhotoRecord({
        id: pDownloadedId,
        bottleId: b1Id,
        driveFileId: 'drive-downloaded',
        updatedAt: '2026-11-09T18:00:00.000Z',
      });

      const syncedAtIso = '2026-11-09T18:00:01.000Z';
      await commitSyncResultToDb({
        bottles: [syncedBottle],
        photosToPurge: [pPurgeId],
        photosToUpsert: [pDownloaded],
        syncedAtIso,
      });

      // 検証:
      const loadedBottle = await getBottle(b1Id);
      expect(loadedBottle?.photoIds).toEqual([p1Id, pDownloadedId]);

      expect(await getPhoto(pPurgeId)).toBeUndefined();
      expect(await getPhoto(pDownloadedId)).toBeDefined();
      expect(await getPhoto(p1Id)).toBeDefined();

      // pendingDeletedPhotos がクリアされていること
      const pending = await getPendingDeletedPhotos();
      expect(pending).toHaveLength(0);

      // バックアップが完全に整合していること
      const backup = await exportBackupData();
      const val = validateBackupData(backup);
      expect(val.success).toBe(true);
      expect(backup.bottles).toHaveLength(1);
      expect(backup.photos).toHaveLength(2);
    });
  });
});
