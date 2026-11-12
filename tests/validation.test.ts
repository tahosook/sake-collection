import { describe, it, expect } from 'vitest';
import {
  isValidCalendarDate,
  validateBackupData,
  validateBottleRecord,
  validateImportBottleJson,
  validatePhotoRecord,
} from '../src/domain/validation';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../src/data/sampleData';
import { BackupData, BottleRecord } from '../src/types/sake';

describe('validation ドメインロジックテスト', () => {
  const validBackup: BackupData = {
    schemaVersion: 1,
    exportedAt: '2026-11-08T12:00:00.000Z',
    bottles: SAMPLE_BOTTLES,
    photos: SAMPLE_PHOTOS,
  };

  describe('isValidCalendarDate', () => {
    it('実在する日付に対して true を返すこと', () => {
      expect(isValidCalendarDate('2026-02-28')).toBe(true);
      expect(isValidCalendarDate('2026-10-25')).toBe(true);
      expect(isValidCalendarDate('2024-02-29')).toBe(true); // うるう年
    });

    it('実在しない日付（うるう年以外の2月29日、2月30日、小の月の31日、月や日の範囲外）を拒否すること', () => {
      expect(isValidCalendarDate('2026-02-29')).toBe(false); // 2026年はうるう年ではない
      expect(isValidCalendarDate('2026-02-30')).toBe(false);
      expect(isValidCalendarDate('2026-04-31')).toBe(false); // 4月は30日まで
      expect(isValidCalendarDate('2026-06-31')).toBe(false); // 6月は30日まで
      expect(isValidCalendarDate('2026-09-31')).toBe(false); // 9月は30日まで
      expect(isValidCalendarDate('2026-11-31')).toBe(false); // 11月は30日まで
      expect(isValidCalendarDate('2026-13-01')).toBe(false); // 13月
      expect(isValidCalendarDate('2026-00-10')).toBe(false); // 0月
      expect(isValidCalendarDate('2026-05-00')).toBe(false); // 0日
      expect(isValidCalendarDate('2026-05-32')).toBe(false); // 32日
      expect(isValidCalendarDate('invalid-date')).toBe(false);
      expect(isValidCalendarDate('2026/05/10')).toBe(false);
    });
  });

  describe('validateBackupData', () => {
    it('正常なバックアップデータオブジェクトの検証が成功すること', () => {
      const result = validateBackupData(validBackup);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.schemaVersion).toBe(1);
        expect(result.data.bottles).toHaveLength(SAMPLE_BOTTLES.length);
        expect(result.data.photos).toHaveLength(SAMPLE_PHOTOS.length);
      }
    });

    it('JSON 文字列として渡された場合もパースして検証が成功すること', () => {
      const jsonStr = JSON.stringify(validBackup);
      const result = validateBackupData(jsonStr);
      expect(result.success).toBe(true);
    });

    it('壊れた JSON 文字列を渡した場合は日本語エラーで拒否されること', () => {
      const brokenJson = '{ "schemaVersion": 1, invalid json';
      const result = validateBackupData(brokenJson);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('バックアップファイルのJSON形式が正しくありません');
      }
    });

    it('未対応の schemaVersion は拒否されること', () => {
      const invalid = { ...validBackup, schemaVersion: 2 };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('未対応のスキーマバージョンです');
      }
    });

    it('未開封ボトルに開封日・飲み切り日・手放した日が入っている場合はアトミックに拒否されること', () => {
      const corruptedBottles = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      const unopened = corruptedBottles.find((b) => b.status === 'unopened')!;
      unopened.openedDate = '2026-10-01'; // 不正

      const invalid = { ...validBackup, bottles: corruptedBottles };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('未開封ボトルの開封日・飲み切り日・手放した日はすべて null である必要があります');
      }
    });

    it('未知の種類が含まれる場合は拒否されること', () => {
      const corruptedBottles = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as Record<string, unknown>[];
      corruptedBottles[0]!['category'] = 'テキーラ'; // 未知の種類

      const invalid = { ...validBackup, bottles: corruptedBottles };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('未知の種類です');
      }
    });

    it('購入価格と相場目安が構造上完全に分離されていることを検証すること', () => {
      const corruptedBottles = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as Record<string, unknown>[];
      // purchaseInfo に不正な価格型
      (corruptedBottles[0]!['purchaseInfo'] as Record<string, unknown>)['purchasePriceYen'] = -500;

      const invalid = { ...validBackup, bottles: corruptedBottles };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('購入価格 (purchasePriceYen) は 0 以上の数値または null である必要があります');
      }
    });

    it('写真の親ボトルがバックアップ内に存在しない場合は拒否されること', () => {
      const corruptedPhotos = JSON.parse(JSON.stringify(SAMPLE_PHOTOS)) as Record<string, unknown>[];
      corruptedPhotos[0]!['bottleId'] = '00000000-9999-4000-8000-000000000000'; // 存在しない親

      const invalid = { ...validBackup, photos: corruptedPhotos };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('親ボトル');
      }
    });

    it('ボトルの photoIds に別ボトルに紐づく写真が含まれている場合は拒否されること（双方向照合）', () => {
      const corruptedBottles = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      // 写真3 (00000000-0001-4000-8000-000000000002 に紐づく) を ボトル1 (00000000-0001-4000-8000-000000000001) の photoIds に追加
      const photo3Id = SAMPLE_PHOTOS[2]!.id;
      corruptedBottles[0]!.photoIds.push(photo3Id);

      const invalid = { ...validBackup, bottles: corruptedBottles };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('持ち主（bottleId:');
      }
    });

    it('ボトルの photoId に対応する写真レコードが存在しない場合は拒否されること', () => {
      const corruptedBottles = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      corruptedBottles[0]!.photoIds.push('11111111-9999-4000-8000-000000000000');

      const invalid = { ...validBackup, bottles: corruptedBottles };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('対応する写真レコードが存在しません');
      }
    });

    it('実在しない日付（2026-02-30 や 2026-13-01）が含まれる場合は拒否されること', () => {
      // 1. 開封日に 2026-02-30 (実在しない)
      const c1 = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      const openedBottle = c1.find((b) => b.status === 'opened')!;
      openedBottle.openedDate = '2026-02-30';
      const res1 = validateBackupData({ ...validBackup, bottles: c1 });
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.error).toContain('openedDate は実在する有効な日付');
      }

      // 2. 飲み切り日に 2026-13-01 (13月)
      const c2 = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      const finishedBottle = c2.find((b) => b.status === 'finished')!;
      finishedBottle.finishedDate = '2026-13-01';
      const res2 = validateBackupData({ ...validBackup, bottles: c2 });
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.error).toContain('finishedDate は実在する有効な日付');
      }

      // 3. 手放した日に 2026-04-31 (4月31日)
      const c3 = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      const disposedBottle = c3.find((b) => b.status === 'disposed')!;
      disposedBottle.disposedDate = '2026-04-31';
      const res3 = validateBackupData({ ...validBackup, bottles: c3 });
      expect(res3.success).toBe(false);
      if (!res3.success) {
        expect(res3.error).toContain('disposedDate は実在する有効な日付');
      }

      // 4. 購入日に 2026-02-29 (平年の2月29日)
      const c4 = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      c4[0]!.purchaseInfo.purchaseDate = '2026-02-29';
      const res4 = validateBackupData({ ...validBackup, bottles: c4 });
      expect(res4.success).toBe(false);
      if (!res4.success) {
        expect(res4.error).toContain('購入日 (purchaseDate) は実在する有効な日付');
      }

      // 5. 相場目安取得日に 2026-00-10 (0月)
      const c5 = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      c5[0]!.referencePrice = {
        estimatedPriceYen: 3000,
        fetchedDate: '2026-00-10',
      };
      const res5 = validateBackupData({ ...validBackup, bottles: c5 });
      expect(res5.success).toBe(false);
      if (!res5.success) {
        expect(res5.error).toContain('相場目安取得日 (fetchedDate) は実在する有効な日付');
      }
    });

    it('1件でも不正があれば部分取り込みを行わず全体が拒否されること (アトミック性)', () => {
      const corruptedBottles = JSON.parse(JSON.stringify(SAMPLE_BOTTLES)) as BottleRecord[];
      corruptedBottles[SAMPLE_BOTTLES.length - 1]!.name = ''; // 最後の1件の名前を空に

      const invalid = { ...validBackup, bottles: corruptedBottles };
      const result = validateBackupData(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('名前は空にできません');
      }
    });
  });

  describe('validateBottleRecord', () => {
    it('正常なボトルレコードを検証通過すること', () => {
      const res = validateBottleRecord(SAMPLE_BOTTLES[0]);
      expect(res.success).toBe(true);
    });

    it('UUID 以外の ID は拒否されること', () => {
      const corrupted = { ...SAMPLE_BOTTLES[0], id: 'not-a-uuid' };
      const res = validateBottleRecord(corrupted);
      expect(res.success).toBe(false);
    });

    it('description が null の場合は検証通過すること', () => {
      const b = { ...SAMPLE_BOTTLES[0], description: null };
      const res = validateBottleRecord(b);
      expect(res.success).toBe(true);
    });

    it('description の 4部構成フィールドが文字列でない場合は拒否されること', () => {
      const b1 = { ...SAMPLE_BOTTLES[0], description: 'not-an-object' };
      expect(validateBottleRecord(b1).success).toBe(false);

      const b2 = {
        ...SAMPLE_BOTTLES[0],
        description: {
          summary: '要約',
          tasteProfile: 123, // 不正
          background: '背景',
          servingSuggestion: '飲み方',
        },
      };
      const res2 = validateBottleRecord(b2);
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.error).toContain('解説 (description) の 4部構成フィールド');
      }
    });

    it('sources が配列でない、または url が不正な場合は拒否されること', () => {
      const b1 = { ...SAMPLE_BOTTLES[0], sources: 'not-an-array' };
      expect(validateBottleRecord(b1).success).toBe(false);

      const b2 = {
        ...SAMPLE_BOTTLES[0],
        sources: [{ title: 'テスト', url: 'ftp://invalid-url.com' }],
      };
      const res2 = validateBottleRecord(b2);
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.error).toContain('出典URL');
      }

      const b3 = {
        ...SAMPLE_BOTTLES[0],
        sources: [{ title: 123, url: 'https://example.com' }],
      };
      expect(validateBottleRecord(b3).success).toBe(false);
    });
  });

  describe('validatePhotoRecord', () => {
    it('正常な写真レコードを検証通過すること', () => {
      const res = validatePhotoRecord(SAMPLE_PHOTOS[0]);
      expect(res.success).toBe(true);
    });

    it('contentHash が 64桁 hex でない場合は拒否されること', () => {
      const corrupted = { ...SAMPLE_PHOTOS[0], contentHash: 'short-hash' };
      const res = validatePhotoRecord(corrupted);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toContain('contentHash は64桁の16進数文字列 (SHA-256) である必要があります');
      }
    });

    it('width / height / byteSize が正の整数でない場合は拒否されること', () => {
      const p1 = { ...SAMPLE_PHOTOS[0], width: 0 };
      expect(validatePhotoRecord(p1).success).toBe(false);

      const p2 = { ...SAMPLE_PHOTOS[0], height: -10 };
      expect(validatePhotoRecord(p2).success).toBe(false);

      const p3 = { ...SAMPLE_PHOTOS[0], byteSize: 12.5 }; // 小数
      expect(validatePhotoRecord(p3).success).toBe(false);

      const p4 = { ...SAMPLE_PHOTOS[0], byteSize: '100' };
      expect(validatePhotoRecord(p4).success).toBe(false);
    });

    it('driveFileId が非空文字列または null の場合は通過し、空文字や不正な型は拒否されること', () => {
      const pValidNull = { ...SAMPLE_PHOTOS[0], driveFileId: null };
      expect(validatePhotoRecord(pValidNull).success).toBe(true);

      const pValidStr = { ...SAMPLE_PHOTOS[0], driveFileId: 'drive-file-id-123' };
      expect(validatePhotoRecord(pValidStr).success).toBe(true);

      const pEmptyStr = { ...SAMPLE_PHOTOS[0], driveFileId: '' };
      expect(validatePhotoRecord(pEmptyStr).success).toBe(false);

      const pWhitespace = { ...SAMPLE_PHOTOS[0], driveFileId: '   ' };
      expect(validatePhotoRecord(pWhitespace).success).toBe(false);

      const pNumber = { ...SAMPLE_PHOTOS[0], driveFileId: 12345 };
      expect(validatePhotoRecord(pNumber).success).toBe(false);
    });
  });

  describe('validateImportBottleJson', () => {
    it('JSON 文字列からの単一ボトル取り込みが成功すること', () => {
      const str = JSON.stringify(SAMPLE_BOTTLES[0]);
      const res = validateImportBottleJson(str);
      expect(res.success).toBe(true);
    });

    it('構文エラーの JSON 文字列を拒否すること', () => {
      const res = validateImportBottleJson('{ broken json');
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toContain('取り込み JSON の構文が正しくありません');
      }
    });
  });
});
