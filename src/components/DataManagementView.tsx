import React, { useState, useRef } from 'react';
import { BackupData, BottleRecord, PhotoRecord } from '../types/sake';
import { ImportBackupResult } from '../storage/db';
import { DownloadIcon, UploadIcon, CheckIcon } from './Icons';

export interface DataManagementViewProps {
  bottles: BottleRecord[];
  allBottles: BottleRecord[];
  photos: PhotoRecord[];
  onExportBackup: () => Promise<BackupData>;
  onImportBackup: (raw: unknown) => Promise<ImportBackupResult>;
  onResetSampleData: () => Promise<{ bottles: number; photos: number }>;
  onClearAll: () => Promise<void>;
}

export const DataManagementView: React.FC<DataManagementViewProps> = ({
  bottles,
  allBottles,
  photos,
  onExportBackup,
  onImportBackup,
  onResetSampleData,
  onClearAll,
}) => {
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 1. バックアップの書き出し (JSON ダウンロード)
  const handleExport = async () => {
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const backup = await onExportBackup();
      const jsonStr = JSON.stringify(backup, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename = `sake-collection-backup-${today}.json`;

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setStatusMessage({
        type: 'success',
        text: `バックアップファイル（${filename}）を書き出しました（ボトル: ${backup.bottles.length}件、写真: ${backup.photos.length}件）。`,
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: `バックアップの書き出し中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // 2. バックアップの読み込み (ファイル選択)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setStatusMessage(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result;
        if (typeof text !== 'string') {
          throw new Error('ファイルの読み込みに失敗しました');
        }

        const res = await onImportBackup(text);
        if (res.success) {
          setStatusMessage({
            type: 'success',
            text: `バックアップの復元が完了しました（ボトル: ${res.count.bottles}件、写真: ${res.count.photos}件）。`,
          });
        } else {
          setStatusMessage({
            type: 'error',
            text: `バックアップの復元に失敗しました（既存データは保護され一切変更されていません）:\n${res.error}`,
          });
        }
      } catch (err) {
        setStatusMessage({
          type: 'error',
          text: `エラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setIsProcessing(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    };

    reader.onerror = () => {
      setStatusMessage({
        type: 'error',
        text: 'ファイルの読み込み中にシステムエラーが発生しました',
      });
      setIsProcessing(false);
    };

    reader.readAsText(file);
  };

  // 3. サンプルデータ投入
  const handleResetSample = async () => {
    if (
      window.confirm(
        '受入確認用サンプルデータを読み込みますか？\n（現在のデータはサンプルデータで置き換えられます）'
      )
    ) {
      setIsProcessing(true);
      setStatusMessage(null);
      try {
        const res = await onResetSampleData();
        setStatusMessage({
          type: 'success',
          text: `受入確認用サンプルデータを読み込みました（ボトル: ${res.bottles}件、写真: ${res.photos}件）。`,
        });
      } catch (err) {
        setStatusMessage({
          type: 'error',
          text: `サンプルデータの読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setIsProcessing(false);
      }
    }
  };

  // 4. 全クリア
  const handleClearAll = async () => {
    if (
      window.confirm(
        'データベース内の全データ（ボトル・写真・メタデータ）を完全に削除しますか？\nこの操作は取り消せません。事前にバックアップの保存をお勧めします。'
      )
    ) {
      setIsProcessing(true);
      setStatusMessage(null);
      try {
        await onClearAll();
        setStatusMessage({
          type: 'success',
          text: 'データベース内の全データを削除しました。',
        });
      } catch (err) {
        setStatusMessage({
          type: 'error',
          text: `データの削除中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setIsProcessing(false);
      }
    }
  };

  // 統計値の計算
  const inventoryBottles = bottles.filter(
    (b) => b.status === 'unopened' || b.status === 'opened'
  );
  const openedCount = inventoryBottles.filter((b) => b.status === 'opened').length;
  const unopenedCount = inventoryBottles.filter((b) => b.status === 'unopened').length;
  const finishedCount = bottles.filter((b) => b.status === 'finished').length;
  const disposedCount = bottles.filter((b) => b.status === 'disposed').length;

  return (
    <div className="space-y-6">
      {/* メッセージ通知バナー */}
      {statusMessage && (
        <div
          className={`p-4 rounded-2xl border text-sm whitespace-pre-line leading-relaxed flex items-start gap-3 ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
          role="alert"
        >
          {statusMessage.type === 'success' && (
            <span className="text-emerald-600 mt-0.5 shrink-0">
              <CheckIcon className="w-5 h-5" />
            </span>
          )}
          <div className="flex-1 font-medium">{statusMessage.text}</div>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="text-stone-400 hover:text-stone-700 min-h-touch min-w-touch flex items-center justify-center p-1 -mr-2 -mt-2"
          >
            ×
          </button>
        </div>
      )}

      {/* コレクション統計カード */}
      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm space-y-3">
        <h2 className="text-sm font-bold text-stone-900">現在のコレクション状況</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
          <div className="bg-stone-50 p-3 rounded-xl border border-stone-200">
            <span className="text-xs text-stone-500 block">家にある酒</span>
            <span className="text-lg font-bold text-stone-900">{inventoryBottles.length}本</span>
            <span className="text-[10px] text-stone-400 block mt-0.5">
              （開 {openedCount} / 未 {unopenedCount}）
            </span>
          </div>
          <div className="bg-stone-50 p-3 rounded-xl border border-stone-200">
            <span className="text-xs text-stone-500 block">飲んだ記録</span>
            <span className="text-lg font-bold text-stone-900">{finishedCount}本</span>
          </div>
          <div className="bg-stone-50 p-3 rounded-xl border border-stone-200">
            <span className="text-xs text-stone-500 block">手放した酒</span>
            <span className="text-lg font-bold text-stone-900">{disposedCount}本</span>
          </div>
          <div className="bg-stone-50 p-3 rounded-xl border border-stone-200">
            <span className="text-xs text-stone-500 block">登録写真</span>
            <span className="text-lg font-bold text-stone-900">{photos.length}枚</span>
          </div>
        </div>
        <p className="text-[11px] text-stone-400 text-right">
          総レコード数: {allBottles.length}本（論理削除含む）
        </p>
      </div>

      {/* バックアップ操作カード */}
      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm space-y-4">
        <div>
          <h2 className="text-base font-bold text-stone-900">データバックアップ</h2>
          <p className="text-xs text-stone-500 mt-1 leading-relaxed">
            端末内の全お酒レコードおよび写真を JSON 形式で保存・復元できます。
            復元時は厳密な整合性検証が行われ、不正なファイルで既存データが壊れることはありません。
          </p>
        </div>

        <div className="space-y-3">
          {/* 書き出しボタン */}
          <button
            type="button"
            onClick={handleExport}
            disabled={isProcessing}
            className="w-full min-h-touch bg-stone-900 hover:bg-stone-800 disabled:bg-stone-400 text-white font-bold text-sm px-4 py-3 rounded-xl transition flex items-center justify-center gap-2 shadow-sm"
          >
            <DownloadIcon className="w-5 h-5" />
            <span>バックアップを書き出す（JSON）</span>
          </button>

          {/* 読み込みボタン (ファイルピッカー) */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".json,application/json"
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="w-full min-h-touch bg-stone-100 hover:bg-stone-200 disabled:opacity-50 text-stone-800 font-bold text-sm px-4 py-3 rounded-xl border border-stone-300 transition flex items-center justify-center gap-2"
          >
            <UploadIcon className="w-5 h-5" />
            <span>バックアップを読み込む（復元）</span>
          </button>
        </div>
      </div>

      {/* サンプルデータ・データリセットカード */}
      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm space-y-4">
        <div>
          <h2 className="text-base font-bold text-stone-900">サンプルデータと初期化</h2>
          <p className="text-xs text-stone-500 mt-1 leading-relaxed">
            受入確認用の各種お酒（日本酒・ワイン・ウイスキー等、全4状態、ヴィンテージ違い等）をワンタップで読み込めます。
          </p>
        </div>

        <div className="space-y-3">
          <button
            type="button"
            onClick={handleResetSample}
            disabled={isProcessing}
            className="w-full min-h-touch bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold text-sm px-4 py-3 rounded-xl transition flex items-center justify-center gap-2"
          >
            <span>受入確認用サンプルデータを読み込む</span>
          </button>

          <button
            type="button"
            onClick={handleClearAll}
            disabled={isProcessing}
            className="w-full min-h-touch bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-bold text-sm px-4 py-3 rounded-xl transition flex items-center justify-center gap-2"
          >
            <span>全データを削除して初期化</span>
          </button>
        </div>
      </div>

      {/* システム仕様・境界情報 */}
      <div className="text-xs text-stone-400 space-y-1 p-2">
        <p>• 正本データは端末内 IndexedDB にローカル保存されています。</p>
        <p>• 外部 LLM API との直接通信は行いません（ローカルファースト設計）。</p>
        <p>• ステップ1: コレクション把握最小版（バージョン 1.0.0）。</p>
      </div>
    </div>
  );
};
