import { describe, it, expect } from 'vitest';
import {
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
