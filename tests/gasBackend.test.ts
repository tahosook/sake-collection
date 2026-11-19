import { describe, it, expect } from 'vitest';
import { createNewBottle } from '../src/domain/bottleUtils';
import { BottleRecord, PhotoRecord, PhotoSyncMeta } from '../src/types/sake';
import { SAMPLE_PHOTOS } from '../src/data/sampleData';
import { createGasTestHarness, GasHarness } from './helpers/gasTestHarness';

const TEST_PASSPHRASE = 'super-secret-test-passphrase-32chars';
const VALID_HASH_1 = '5b5fb70ef1caa9e30dc86acc6ace2cc51950471127e5e8f40b86e578de09da3d';

function makeBottleUuid(n: number): string {
  const suffix = String(n).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

function makePhotoUuid(n: number): string {
  const suffix = String(n).padStart(12, '0');
  return `11111111-0000-4000-8000-${suffix}`;
}

function makeBottle(n: number, overrides: Partial<BottleRecord<'日本酒'>> = {}): BottleRecord {
  const base = createNewBottle(
    {
      name: overrides.name ?? `テスト銘柄 ${n}`,
      category: '日本酒',
      status: overrides.status ?? 'unopened',
      photoIds: overrides.photoIds ? [...overrides.photoIds] : [],
      primaryPhotoId: overrides.primaryPhotoId ?? null,
      tastingNote: overrides.tastingNote ?? '',
      wantToBuyAgain: overrides.wantToBuyAgain ?? false,
    },
    {
      id: overrides.id ?? makeBottleUuid(n),
      nowIso: overrides.updatedAt ?? overrides.createdAt ?? '2026-11-18T10:00:00.000Z',
    }
  );
  return {
    ...base,
    ...overrides,
    createdAt: overrides.createdAt ?? base.createdAt,
    updatedAt: overrides.updatedAt ?? base.updatedAt,
    deleted: overrides.deleted ?? base.deleted,
  };
}

function makePhotoMeta(
  n: number,
  bottleId: string,
  overrides: Partial<PhotoSyncMeta> = {}
): PhotoSyncMeta {
  return {
    id: overrides.id ?? makePhotoUuid(n),
    bottleId,
    mimeType: overrides.mimeType ?? 'image/jpeg',
    width: overrides.width ?? 400,
    height: overrides.height ?? 500,
    byteSize: overrides.byteSize ?? 144,
    contentHash: overrides.contentHash ?? VALID_HASH_1,
    driveFileId: overrides.driveFileId !== undefined ? overrides.driveFileId : null,
    createdAt: overrides.createdAt ?? '2026-11-18T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-11-18T10:00:00.000Z',
    deleted: overrides.deleted ?? false,
  };
}

function makePhotoRecord(
  n: number,
  bottleId: string,
  overrides: Partial<PhotoRecord> = {}
): PhotoRecord {
  const meta = makePhotoMeta(n, bottleId, overrides);
  return {
    ...meta,
    dataUrl: overrides.dataUrl ?? SAMPLE_PHOTOS[0]!.dataUrl,
  };
}

function seedBottlesOnServer(
  harness: GasHarness,
  bottles: BottleRecord[],
  photoMetas: PhotoSyncMeta[] = []
): Record<string, unknown> {
  return harness.post({
    action: 'sync_metadata',
    passphrase: TEST_PASSPHRASE,
    isInitialEmptyClient: false,
    bottles,
    photoMetas,
  });
}

describe('GAS バックエンド (gas/Code.gs) 恒常テスト (M2 / M3 / M5 / D3)', () => {
  describe('認証・設定・誤接続・ロック制御 (fail-closed)', () => {
    it('doGet は METHOD_NOT_ALLOWED を返すこと', () => {
      const harness = createGasTestHarness();
      const res = harness.get();
      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('METHOD_NOT_ALLOWED');
    });

    it('空ボディ・不正 JSON・配列ボディは BAD_REQUEST を返すこと', () => {
      const harness = createGasTestHarness();
      expect(harness.postRaw(null)['errorCode']).toBe('BAD_REQUEST');
      expect(harness.postRaw('{ broken json')['errorCode']).toBe('BAD_REQUEST');
      expect(harness.postRaw('[]')['errorCode']).toBe('BAD_REQUEST');
    });

    it('スクリプトプロパティ欠落時は CONFIG_ERROR で全リクエストを拒否すること', () => {
      const harness = createGasTestHarness({ skipInitialProperties: true });
      const res = harness.post({ action: 'ping', passphrase: TEST_PASSPHRASE });
      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('CONFIG_ERROR');
    });

    it('合言葉不一致時は UNAUTHORIZED を返しシートを作成・変更しないこと', () => {
      const harness = createGasTestHarness();
      const res = harness.post({ action: 'ping', passphrase: 'wrong-passphrase' });
      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('UNAUTHORIZED');
    });

    it('別アプリの appIdentifier が設定されたスプレッドシートは INVALID_APP_IDENTIFIER で拒否すること', () => {
      const harness = createGasTestHarness({ initialAppIdentifier: 'other-app' });
      const res = harness.post({ action: 'ping', passphrase: TEST_PASSPHRASE });
      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('INVALID_APP_IDENTIFIER');
    });

    it('Drive フォルダが公開設定 (ANYONE_WITH_LINK / ANYONE) の場合は INSECURE_DRIVE_FOLDER で拒否すること', () => {
      const harness = createGasTestHarness({ sharingAccess: 'ANYONE_WITH_LINK' });
      const res = harness.post({ action: 'ping', passphrase: TEST_PASSPHRASE });
      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('INSECURE_DRIVE_FOLDER');
    });

    it('LockService 取得失敗時は LOCK_TIMEOUT を返すこと', () => {
      const harness = createGasTestHarness();
      harness.faults.forceLockTimeout = true;
      const res = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [],
        photoMetas: [],
      });
      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('LOCK_TIMEOUT');
    });

    it('正常 ping で appIdentifier と件数と serverTime を返すこと', () => {
      const harness = createGasTestHarness({ nowIso: '2026-11-19T01:00:00.000Z' });
      const b1 = makeBottle(1);
      seedBottlesOnServer(harness, [b1]);

      const res = harness.post<{
        ok: boolean;
        appIdentifier: string;
        serverTime: string;
        counts: { bottlesTotal: number; bottlesActive: number };
      }>({ action: 'ping', passphrase: TEST_PASSPHRASE });

      expect(res.ok).toBe(true);
      expect(res.appIdentifier).toBe('sake-collection');
      expect(res.serverTime).toBe('2026-11-19T01:00:00.000Z');
      expect(res.counts.bottlesTotal).toBe(1);
      expect(res.counts.bottlesActive).toBe(1);
    });
  });

  describe('同期マージ・空端末保護・写真送受信・重複排除 (D3)', () => {
    it('LWW 競合解決と同一時刻タイブレーク（deleted === true 優先、同じならサーバー維持）が動作すること', () => {
      const harness = createGasTestHarness();
      const b1Server = makeBottle(1, { name: 'サーバー新', updatedAt: '2026-11-18T12:00:00.000Z' });
      const b2Server = makeBottle(2, { name: 'サーバー同刻', updatedAt: '2026-11-18T12:00:00.000Z' });
      const b3Server = makeBottle(3, { name: 'サーバー旧', updatedAt: '2026-11-18T10:00:00.000Z' });
      seedBottlesOnServer(harness, [b1Server, b2Server, b3Server]);

      const b1Client = makeBottle(1, { name: 'クライアント旧', updatedAt: '2026-11-18T11:00:00.000Z' });
      const b2ClientDeleted = makeBottle(2, {
        name: 'クライアント同刻削除',
        updatedAt: '2026-11-18T12:00:00.000Z',
        deleted: true,
      });
      const b3Client = makeBottle(3, { name: 'クライアント新', updatedAt: '2026-11-18T13:00:00.000Z' });

      const res = harness.post<{ ok: boolean; bottles: BottleRecord[] }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [b1Client, b2ClientDeleted, b3Client],
        photoMetas: [],
      });

      expect(res.ok).toBe(true);
      const map = new Map(res.bottles.map((b) => [b.id, b]));
      expect(map.get(b1Server.id)?.name).toBe('サーバー新');
      expect(map.get(b2Server.id)?.deleted).toBe(true);
      expect(map.get(b3Server.id)?.name).toBe('クライアント新');
    });

    it('upload_photo で Drive 保存と contentHash 重複排除が行われ、download_photos で復元できること', () => {
      const harness = createGasTestHarness();
      const p1Id = makePhotoUuid(1);
      const p2Id = makePhotoUuid(2);
      const b1 = makeBottle(1, { photoIds: [p1Id], primaryPhotoId: p1Id });
      const b2 = makeBottle(2, { photoIds: [p2Id], primaryPhotoId: p2Id });
      const p1 = makePhotoRecord(1, b1.id, { contentHash: VALID_HASH_1 });
      const p2 = makePhotoRecord(2, b2.id, { contentHash: VALID_HASH_1 }); // 同一ハッシュ

      const syncRes = harness.post<{ ok: boolean; photosToUpload: string[] }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [b1, b2],
        photoMetas: [
          { ...p1, dataUrl: undefined } as unknown as PhotoSyncMeta,
          { ...p2, dataUrl: undefined } as unknown as PhotoSyncMeta,
        ],
      });
      expect(syncRes.ok).toBe(true);
      expect(syncRes.photosToUpload.sort()).toEqual([p1Id, p2Id].sort());

      const up1 = harness.post<{ ok: boolean; driveFileId: string; deduplicated: boolean }>({
        action: 'upload_photo',
        passphrase: TEST_PASSPHRASE,
        photo: p1,
      });
      expect(up1.ok).toBe(true);
      expect(up1.deduplicated).toBe(false);

      const up2 = harness.post<{ ok: boolean; driveFileId: string; deduplicated: boolean }>({
        action: 'upload_photo',
        passphrase: TEST_PASSPHRASE,
        photo: p2,
      });
      expect(up2.ok).toBe(true);
      expect(up2.deduplicated).toBe(true);
      expect(up2.driveFileId).toBe(up1.driveFileId);
      expect(harness.listActiveDriveFileIds()).toHaveLength(1);

      const dlRes = harness.post<{ ok: boolean; photos: PhotoRecord[] }>({
        action: 'download_photos',
        passphrase: TEST_PASSPHRASE,
        photoIds: [p1Id],
      });
      expect(dlRes.ok).toBe(true);
      expect(dlRes.photos).toHaveLength(1);
      expect(dlRes.photos[0]?.dataUrl).toBe(p1.dataUrl);
    });

    it('pendingDeletedPhotos で外された写真のみ孤立 Drive ファイルとしてゴミ箱へ移動すること', () => {
      const harness = createGasTestHarness();
      const p1Id = makePhotoUuid(1);
      const b1 = makeBottle(1, {
        photoIds: [p1Id],
        primaryPhotoId: p1Id,
        updatedAt: '2026-11-18T10:00:00.000Z',
      });
      const p1 = makePhotoRecord(1, b1.id);

      seedBottlesOnServer(harness, [b1], [makePhotoMeta(1, b1.id)]);
      const up = harness.post<{ ok: boolean; driveFileId: string }>({
        action: 'upload_photo',
        passphrase: TEST_PASSPHRASE,
        photo: p1,
      });
      expect(up.ok).toBe(true);
      expect(harness.getDriveFile(up.driveFileId)?.trashed).toBe(false);

      const b1Updated = makeBottle(1, {
        photoIds: [],
        primaryPhotoId: null,
        updatedAt: '2026-11-18T12:00:00.000Z',
      });
      const pendingDeleted = makePhotoMeta(1, b1.id, {
        driveFileId: up.driveFileId,
        deleted: true,
        updatedAt: '2026-11-18T12:00:00.000Z',
      });

      const sync2 = harness.post<{ ok: boolean; photoMetas: PhotoSyncMeta[] }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [b1Updated],
        photoMetas: [],
        pendingDeletedPhotos: [pendingDeleted],
      });
      expect(sync2.ok).toBe(true);
      expect(sync2.photoMetas[0]?.deleted).toBe(true);
      expect(harness.getDriveFile(up.driveFileId)?.trashed).toBe(true);
    });
  });

  describe('M2: シート書き込み非破壊化・破損行 fail-closed・サイズ上限事前拒否', () => {
    it('clearContents() を一度も呼ばず、行数減少時も末尾余剰行のみクリアすること', () => {
      const harness = createGasTestHarness();
      const b1 = makeBottle(1);
      const b2 = makeBottle(2);
      const b3 = makeBottle(3);
      seedBottlesOnServer(harness, [b1, b2, b3]);

      const bottlesSheet = harness.getSheet('Bottles');
      expect(bottlesSheet.clearContentsCallCount).toBe(0);
      expect(bottlesSheet.getRawRows()).toHaveLength(4); // ヘッダー + 3件

      // 意図的にシート末尾に古い余剰行を残した状態から、2件上書きになるケースを検証
      bottlesSheet.appendRow(['extra', '', '', false, 'extra', '', '', JSON.stringify(makeBottle(99))]);
      expect(bottlesSheet.getRawRows()).toHaveLength(5);

      const res = harness.post<{ ok: boolean; bottles: BottleRecord[] }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [
          makeBottle(1),
          makeBottle(2),
          makeBottle(3),
          makeBottle(99, { deleted: true, updatedAt: '2026-11-18T14:00:00.000Z' }),
        ],
        photoMetas: [],
      });
      expect(res.ok).toBe(true);
      expect(bottlesSheet.clearContentsCallCount).toBe(0);
      expect(bottlesSheet.getRawRows()).toHaveLength(5);
    });

    it('setValues 書き込み中に例外が発生しても、既存シートのデータおよび削除記録が空にならず残ること', () => {
      const harness = createGasTestHarness();
      const b1 = makeBottle(1, { name: '保持される酒' });
      const b2Deleted = makeBottle(2, { name: '削除記録', deleted: true });
      seedBottlesOnServer(harness, [b1, b2Deleted]);

      const bottlesSheet = harness.getSheet('Bottles');
      const snapshotBefore = bottlesSheet.getRawRows();

      harness.faults.onBeforeSetValues = (sheetName) => {
        if (sheetName === 'Bottles') {
          throw new Error('Simulated Sheets transient write failure');
        }
      };

      const res = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [b1, b2Deleted, makeBottle(3, { name: '新規酒' })],
        photoMetas: [],
      });

      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('INTERNAL_ERROR');
      expect(bottlesSheet.clearContentsCallCount).toBe(0);
      expect(bottlesSheet.getRawRows()).toEqual(snapshotBefore);
    });

    it('シートにパース不能 JSON 行がある場合 CORRUPTED_SHEET_DATA で停止し、シートを上書きしないこと', () => {
      const harness = createGasTestHarness();
      const b1 = makeBottle(1, { name: '正常レコード' });
      seedBottlesOnServer(harness, [b1]);

      const bottlesSheet = harness.getSheet('Bottles');
      bottlesSheet.appendRow([
        'corrupted-id',
        '2026-11-18T10:00:00.000Z',
        '2026-11-18T10:00:00.000Z',
        false,
        '破損行',
        '日本酒',
        'unopened',
        '{ invalid json !!!',
      ]);
      const snapshotBefore = bottlesSheet.getRawRows();

      const pingRes = harness.post({ action: 'ping', passphrase: TEST_PASSPHRASE });
      expect(pingRes['ok']).toBe(false);
      expect(pingRes['errorCode']).toBe('CORRUPTED_SHEET_DATA');

      const syncRes = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [makeBottle(2)],
        photoMetas: [],
      });
      expect(syncRes['ok']).toBe(false);
      expect(syncRes['errorCode']).toBe('CORRUPTED_SHEET_DATA');
      expect(bottlesSheet.getRawRows()).toEqual(snapshotBefore);
    });

    it('49,000 文字超のレコードが含まれる場合 RECORD_TOO_LARGE で事前拒否し、両シートを書き換えないこと', () => {
      const harness = createGasTestHarness();
      const b1 = makeBottle(1, { name: '既存酒' });
      seedBottlesOnServer(harness, [b1]);

      const bottlesSheet = harness.getSheet('Bottles');
      const snapshotBefore = bottlesSheet.getRawRows();

      const hugeBottle = makeBottle(2, {
        tastingNote: 'あ'.repeat(49500),
      });

      const res = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [hugeBottle],
        photoMetas: [],
      });

      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('RECORD_TOO_LARGE');
      expect(bottlesSheet.getRawRows()).toEqual(snapshotBefore);
    });
  });

  describe('M3: Drive 3値判定（一時エラー時に driveFileId を消さない）', () => {
    it('Drive フォルダ一覧取得 (getFiles) で一時エラーが出た場合、DRIVE_TEMPORARY_ERROR を返し driveFileId を保持すること', () => {
      const harness = createGasTestHarness();
      const p1Id = makePhotoUuid(1);
      const b1 = makeBottle(1, { photoIds: [p1Id], primaryPhotoId: p1Id });
      const p1Meta = makePhotoMeta(1, b1.id, { driveFileId: 'drive-existing-1' });
      harness.seedDriveFile('drive-existing-1', new Uint8Array([1, 2, 3]));
      seedBottlesOnServer(harness, [b1], [p1Meta]);

      harness.faults.onListFolderFiles = () => {
        throw new Error('Service invoked too many times for one day: drive.');
      };

      const res = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [b1],
        photoMetas: [p1Meta],
      });

      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('DRIVE_TEMPORARY_ERROR');

      // Photos シートの driveFileId が消されていないこと
      harness.faults.onListFolderFiles = undefined;
      const photosRows = harness.getSheet('Photos').getRawRows();
      expect(photosRows[1]?.[3]).toBe('drive-existing-1');
    });

    it('DriveApp.getFileById で一時エラーが出た場合、DRIVE_TEMPORARY_ERROR を返し driveFileId を消さないこと', () => {
      const harness = createGasTestHarness();
      const p1Id = makePhotoUuid(1);
      const b1 = makeBottle(1, { photoIds: [p1Id], primaryPhotoId: p1Id });
      const p1Meta = makePhotoMeta(1, b1.id, { driveFileId: 'drive-outside-folder-1' });
      // フォルダ列挙には入らず個別 getFileById を踏ませるため、inFolder=false で登録
      harness.seedDriveFile('drive-outside-folder-1', new Uint8Array([1, 2, 3]), 'image/jpeg', false, 'outside.jpg', false);
      seedBottlesOnServer(harness, [b1], [p1Meta]);

      harness.faults.onGetDriveFileById = (fileId) => {
        if (fileId === 'drive-outside-folder-1') {
          throw new Error('Internal timeout while contacting Drive backend');
        }
      };

      const res = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [b1],
        photoMetas: [p1Meta],
      });

      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('DRIVE_TEMPORARY_ERROR');
      const photosRows = harness.getSheet('Photos').getRawRows();
      expect(photosRows[1]?.[3]).toBe('drive-outside-folder-1');
    });

    it('Drive 上でゴミ箱済みまたは明確に不存在の場合のみ driveFileId を null にクリアすること', () => {
      const harness = createGasTestHarness();
      const p1Id = makePhotoUuid(1);
      const b1 = makeBottle(1, { photoIds: [p1Id], primaryPhotoId: p1Id });
      const p1Meta = makePhotoMeta(1, b1.id, { driveFileId: 'drive-trashed-1' });
      harness.seedDriveFile('drive-trashed-1', new Uint8Array([1, 2, 3]), 'image/jpeg', false);
      seedBottlesOnServer(harness, [b1], [p1Meta]);

      // Drive 上でゴミ箱へ移動された状態を再現
      harness.getDriveFile('drive-trashed-1')!.trashed = true;

      const res = harness.post<{
        ok: boolean;
        photoMetas: PhotoSyncMeta[];
        photosToUpload: string[];
      }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [b1],
        photoMetas: [p1Meta],
      });

      expect(res.ok).toBe(true);
      expect(res.photoMetas[0]?.driveFileId).toBeNull();
      expect(res.photosToUpload).toEqual([p1Id]);
    });

    it('upload_photo の重複排除確認や download_photos 中の Drive 一時エラーでも DRIVE_TEMPORARY_ERROR を返すこと', () => {
      const harness = createGasTestHarness();
      const p1Id = makePhotoUuid(1);
      const p2Id = makePhotoUuid(2);
      const b1 = makeBottle(1, { photoIds: [p1Id, p2Id], primaryPhotoId: p1Id });
      const p1Meta = makePhotoMeta(1, b1.id, { driveFileId: 'drive-unstable-1', contentHash: VALID_HASH_1 });
      const p2 = makePhotoRecord(2, b1.id, { contentHash: VALID_HASH_1 });
      harness.seedDriveFile('drive-unstable-1', new Uint8Array([1, 2, 3]));
      seedBottlesOnServer(harness, [b1], [p1Meta]);

      harness.faults.onGetDriveFileById = (fileId) => {
        if (fileId === 'drive-unstable-1') {
          throw new Error('Transient Drive 503 error');
        }
      };

      const upRes = harness.post({
        action: 'upload_photo',
        passphrase: TEST_PASSPHRASE,
        photo: p2,
      });
      expect(upRes['ok']).toBe(false);
      expect(upRes['errorCode']).toBe('DRIVE_TEMPORARY_ERROR');

      const dlRes = harness.post({
        action: 'download_photos',
        passphrase: TEST_PASSPHRASE,
        photoIds: [p1Id],
      });
      expect(dlRes['ok']).toBe(false);
      expect(dlRes['errorCode']).toBe('DRIVE_TEMPORARY_ERROR');
    });
  });

  describe('M5: スキーマ検証・未来日時ガード (+24h)・大量削除ガード', () => {
    it('不正なペイロード（非配列、不正 UUID、未知種類、不正 MIME、download 上限超）を拒否すること', () => {
      const harness = createGasTestHarness();

      expect(
        harness.post({
          action: 'sync_metadata',
          passphrase: TEST_PASSPHRASE,
          bottles: 'not-an-array',
          photoMetas: [],
        })['errorCode']
      ).toBe('INVALID_PAYLOAD');

      const badBottle = makeBottle(1);
      expect(
        harness.post({
          action: 'sync_metadata',
          passphrase: TEST_PASSPHRASE,
          bottles: [{ ...badBottle, category: '存在しない酒類' }],
          photoMetas: [],
        })['errorCode']
      ).toBe('INVALID_PAYLOAD');

      expect(
        harness.post({
          action: 'upload_photo',
          passphrase: TEST_PASSPHRASE,
          photo: {
            ...makePhotoRecord(1, makeBottleUuid(1)),
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA',
          },
        })['errorCode']
      ).toBe('INVALID_PHOTO_PAYLOAD');

      const tooManyIds = Array.from({ length: 11 }, (_, i) => makePhotoUuid(i + 1));
      expect(
        harness.post({
          action: 'download_photos',
          passphrase: TEST_PASSPHRASE,
          photoIds: tooManyIds,
        })['errorCode']
      ).toBe('INVALID_PAYLOAD');
    });

    it('サーバー時刻 +24時間を超える未来の updatedAt は INVALID_TIMESTAMP で拒否し、+23時間は許可すること', () => {
      const harness = createGasTestHarness({ nowIso: '2026-11-19T00:00:00.000Z' });

      const future25h = makeBottle(1, { updatedAt: '2026-11-20T01:00:00.000Z' });
      const rejectRes = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [future25h],
        photoMetas: [],
      });
      expect(rejectRes['ok']).toBe(false);
      expect(rejectRes['errorCode']).toBe('INVALID_TIMESTAMP');

      const future23h = makeBottle(1, { updatedAt: '2026-11-19T23:00:00.000Z' });
      const allowRes = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [future23h],
        photoMetas: [],
      });
      expect(allowRes['ok']).toBe(true);
    });

    it('10本存在時に6本以上（過半数かつ5本以上）または3本以上全消去を MASS_DELETE_BLOCKED で阻止し、シート・Drive を変更しないこと', () => {
      const harness = createGasTestHarness();
      const bottles = Array.from({ length: 10 }, (_, i) => makeBottle(i + 1));
      seedBottlesOnServer(harness, bottles);

      const snapshotBefore = harness.getSheet('Bottles').getRawRows();

      // 6本を同時削除しようとする攻撃的リクエスト
      const attackSix = bottles.map((b, i) =>
        i < 6
          ? { ...b, deleted: true, updatedAt: '2026-11-18T15:00:00.000Z' }
          : b
      );
      const resSix = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: attackSix,
        photoMetas: [],
      });
      expect(resSix['ok']).toBe(false);
      expect(resSix['errorCode']).toBe('MASS_DELETE_BLOCKED');
      expect(harness.getSheet('Bottles').getRawRows()).toEqual(snapshotBefore);

      // 3本だけのコレクションで全3本削除 (100% 消去) も阻止されること
      const harness3 = createGasTestHarness();
      const threeBottles = [makeBottle(1), makeBottle(2), makeBottle(3)];
      seedBottlesOnServer(harness3, threeBottles);
      const resAllThree = harness3.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: threeBottles.map((b) => ({
          ...b,
          deleted: true,
          updatedAt: '2026-11-18T15:00:00.000Z',
        })),
        photoMetas: [],
      });
      expect(resAllThree['ok']).toBe(false);
      expect(resAllThree['errorCode']).toBe('MASS_DELETE_BLOCKED');
    });

    it('通常の少数削除（10本中4本）および正規操作「全データを削除して初期化」後の同期は阻害されないこと', () => {
      const harness = createGasTestHarness();
      const bottles = Array.from({ length: 10 }, (_, i) => makeBottle(i + 1));
      seedBottlesOnServer(harness, bottles);

      // 1. 通常の4本削除は許可される
      const fourDeleted = bottles.map((b, i) =>
        i < 4
          ? { ...b, deleted: true, updatedAt: '2026-11-18T15:00:00.000Z' }
          : b
      );
      const normalDelRes = harness.post<{ ok: boolean; bottles: BottleRecord[] }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: fourDeleted,
        photoMetas: [],
      });
      expect(normalDelRes.ok).toBe(true);
      expect(normalDelRes.bottles.filter((b) => !b.deleted)).toHaveLength(6);

      // 2. 端末側で「全データを削除して初期化」(clearDatabase) 実行後の再同期 (isInitialEmptyClient: true)
      const restoreRes = harness.post<{ ok: boolean; bottles: BottleRecord[] }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: true,
        bottles: [],
        photoMetas: [],
        pendingDeletedPhotos: [],
      });
      expect(restoreRes.ok).toBe(true);
      expect(restoreRes.bottles.filter((b) => !b.deleted)).toHaveLength(6);

      // 3. 「全データを削除して初期化」後に新規1本を登録して同期してもサーバー既存6本は守られ成功すること
      const newLocalBottle = makeBottle(99, { name: '初期化後に登録した酒' });
      const afterClearAddRes = harness.post<{ ok: boolean; bottles: BottleRecord[] }>({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: [newLocalBottle],
        photoMetas: [],
      });
      expect(afterClearAddRes.ok).toBe(true);
      expect(afterClearAddRes.bottles.filter((b) => !b.deleted)).toHaveLength(7);
    });

    it('1回の同期で20件超の Drive ファイルをゴミ箱移動しようとした場合は MASS_DELETE_BLOCKED で阻止されること', () => {
      const harness = createGasTestHarness();
      // 4本のボトルに計21枚の同期済み写真を紐付ける（ボトル削除は4本だが Drive ゴミ箱が21件）
      const bottles: BottleRecord[] = [];
      const metas: PhotoSyncMeta[] = [];
      let photoSeq = 1;
      for (let bIdx = 1; bIdx <= 4; bIdx++) {
        const bId = makeBottleUuid(bIdx);
        const count = bIdx === 1 ? 6 : 5;
        const pIds: string[] = [];
        for (let k = 0; k < count; k++) {
          const pId = makePhotoUuid(photoSeq);
          const driveId = `drive-bulk-${photoSeq}`;
          harness.seedDriveFile(driveId, new Uint8Array([1, 2, 3]));
          pIds.push(pId);
          metas.push(makePhotoMeta(photoSeq, bId, { driveFileId: driveId }));
          photoSeq++;
        }
        bottles.push(makeBottle(bIdx, { photoIds: pIds, primaryPhotoId: pIds[0] ?? null }));
      }
      // 既存の有効ボトルを10本にしてボトル側過半数ルールを回避し、Drive 21件ルール単独をテスト
      for (let extra = 5; extra <= 10; extra++) {
        bottles.push(makeBottle(extra));
      }

      seedBottlesOnServer(harness, bottles, metas);

      const updatedBottles = bottles.map((b, idx) =>
        idx < 4
          ? {
              ...b,
              deleted: true,
              photoIds: [],
              primaryPhotoId: null,
              updatedAt: '2026-11-18T16:00:00.000Z',
            }
          : b
      );

      const res = harness.post({
        action: 'sync_metadata',
        passphrase: TEST_PASSPHRASE,
        isInitialEmptyClient: false,
        bottles: updatedBottles,
        photoMetas: [],
      });

      expect(res['ok']).toBe(false);
      expect(res['errorCode']).toBe('MASS_DELETE_BLOCKED');
      // 21件の Drive ファイルが1件もゴミ箱移動されていないこと
      expect(harness.listActiveDriveFileIds()).toHaveLength(21);
    });
  });
});
