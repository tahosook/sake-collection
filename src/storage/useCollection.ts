import { useState, useEffect, useCallback } from 'react';
import { BottleRecord, PhotoRecord, BottleStatus, BackupData } from '../types/sake';
import {
  getAllBottles,
  getAllPhotos,
  saveBottle,
  deleteBottle as dbDeleteBottle,
  exportBackupData,
  importBackupData,
  loadSampleData,
  clearDatabase,
  ImportBackupResult,
} from './db';
import {
  createNewBottle,
  CreateBottleInput,
  transitionBottleStatus,
} from '../domain/bottleUtils';

export interface UseCollectionReturn {
  /** 有効なボトル一覧（未削除） */
  bottles: BottleRecord[];
  /** 全ボトル（論理削除済みを含む） */
  allBottles: BottleRecord[];
  /** 有効な写真一覧 */
  photos: PhotoRecord[];
  /** 読み込み中フラグ */
  isLoading: boolean;
  /** エラーメッセージ */
  error: string | null;

  /** データを再取得してローカル状態を更新 */
  refresh: () => Promise<void>;

  /** 新規ボトルを手入力登録して永続化 */
  addBottle: <C extends BottleRecord['category']>(input: CreateBottleInput<C>) => Promise<BottleRecord<C>>;

  /** ボトルを更新して永続化 */
  updateBottle: (bottle: BottleRecord) => Promise<void>;

  /** ボトルの状態を変更して日付ルールを適用・永続化 */
  changeBottleStatus: (
    bottleId: string,
    newStatus: BottleStatus,
    dateOverride?: string | null
  ) => Promise<BottleRecord | null>;

  /** ボトルを論理削除 */
  deleteBottle: (bottleId: string) => Promise<void>;

  /** バックアップデータをエクスポート */
  exportBackup: () => Promise<BackupData>;

  /** バックアップ JSON を検証・復元 */
  importBackup: (raw: unknown) => Promise<ImportBackupResult>;

  /** サンプルデータを読み込んで復元 */
  resetWithSampleData: () => Promise<{ bottles: number; photos: number }>;

  /** 全データをクリア */
  clearAll: () => Promise<void>;
}

/**
 * コレクションの状態管理・操作用カスタムフック
 */
export function useCollection(): UseCollectionReturn {
  const [allBottles, setAllBottles] = useState<BottleRecord[]>([]);
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [loadedBottles, loadedPhotos] = await Promise.all([
        getAllBottles(true), // 全件取得
        getAllPhotos(false),
      ]);
      setAllBottles(loadedBottles);
      setPhotos(loadedPhotos);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addBottle = useCallback(
    async <C extends BottleRecord['category']>(input: CreateBottleInput<C>): Promise<BottleRecord<C>> => {
      const newBottle = createNewBottle(input);
      await saveBottle(newBottle);
      await refresh();
      return newBottle;
    },
    [refresh]
  );

  const updateBottle = useCallback(
    async (bottle: BottleRecord): Promise<void> => {
      const updated: BottleRecord = {
        ...bottle,
        updatedAt: new Date().toISOString(),
      };
      await saveBottle(updated);
      await refresh();
    },
    [refresh]
  );

  const changeBottleStatus = useCallback(
    async (
      bottleId: string,
      newStatus: BottleStatus,
      dateOverride?: string | null
    ): Promise<BottleRecord | null> => {
      const target = allBottles.find((b) => b.id === bottleId);
      if (!target) {
        return null;
      }
      const updated = transitionBottleStatus(target, newStatus, {
        dateOverride,
      });
      await saveBottle(updated);
      await refresh();
      return updated;
    },
    [allBottles, refresh]
  );

  const deleteBottle = useCallback(
    async (bottleId: string): Promise<void> => {
      await dbDeleteBottle(bottleId);
      await refresh();
    },
    [refresh]
  );

  const exportBackup = useCallback(async (): Promise<BackupData> => {
    return exportBackupData();
  }, []);

  const importBackup = useCallback(
    async (raw: unknown): Promise<ImportBackupResult> => {
      const res = await importBackupData(raw);
      if (res.success) {
        await refresh();
      }
      return res;
    },
    [refresh]
  );

  const resetWithSampleData = useCallback(async () => {
    const res = await loadSampleData();
    await refresh();
    return res;
  }, [refresh]);

  const clearAll = useCallback(async () => {
    await clearDatabase();
    await refresh();
  }, [refresh]);

  const bottles = allBottles.filter((b) => !b.deleted);

  return {
    bottles,
    allBottles,
    photos,
    isLoading,
    error,
    refresh,
    addBottle,
    updateBottle,
    changeBottleStatus,
    deleteBottle,
    exportBackup,
    importBackup,
    resetWithSampleData,
    clearAll,
  };
}
