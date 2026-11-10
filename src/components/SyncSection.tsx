import React, { useState, useEffect, useCallback } from 'react';
import { SyncConnectionConfig } from '../types/sake';
import {
  executeFullSync,
  fetchAutoSyncConfig,
  testSyncConnection,
  SyncProgress,
} from '../services/syncService';
import { getSyncConfig, saveSyncConfig, getLastSyncAt } from '../storage/db';
import { CloudIcon, ArrowPathIcon, CheckIcon, SettingsIcon, ChevronDownIcon } from './Icons';

export interface SyncSectionProps {
  onSyncComplete?: () => Promise<void> | void;
  className?: string;
  isSettingsOpen?: boolean;
  onToggleSettings?: () => void;
  children?: React.ReactNode;
}

export const SyncSection: React.FC<SyncSectionProps> = ({
  onSyncComplete,
  className = '',
  isSettingsOpen: externalIsSettingsOpen,
  onToggleSettings: externalOnToggleSettings,
  children,
}) => {
  const [config, setConfig] = useState<SyncConnectionConfig | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // 折りたたみ状態 (外部制御または内部制御)
  const [internalIsOpen, setInternalIsOpen] = useState<boolean>(false);
  const isSettingsOpen = externalIsSettingsOpen !== undefined ? externalIsSettingsOpen : internalIsOpen;
  const toggleSettings = externalOnToggleSettings || (() => setInternalIsOpen((prev) => !prev));

  // 手動入力フォーム用状態
  const [gasUrlInput, setGasUrlInput] = useState<string>('');
  const [passphraseInput, setPassphraseInput] = useState<string>('');
  const [showPassphrase, setShowPassphrase] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isFetchingAuto, setIsFetchingAuto] = useState<boolean>(false);

  // 初期化: 設定と最終同期日時を読み込み
  const loadInitialState = useCallback(async () => {
    try {
      let currentConfig = await getSyncConfig();
      if (!currentConfig) {
        // 設定未保存なら自動取得を試行
        const autoRes = await fetchAutoSyncConfig();
        if (autoRes.success && autoRes.config) {
          currentConfig = autoRes.config;
        }
      }

      if (currentConfig) {
        setConfig(currentConfig);
        setGasUrlInput(currentConfig.gasUrl);
        setPassphraseInput(currentConfig.passphrase);
      }

      const lastSync = await getLastSyncAt();
      setLastSyncAt(lastSync);
    } catch {
      // 初期化失敗時は静かにスルー
    }
  }, []);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

  // 日時フォーマット (YYYY-MM-DD HH:mm)
  const formatSyncTime = (isoString: string | null): string => {
    if (!isoString) return '未同期';
    try {
      const d = new Date(isoString);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return isoString;
    }
  };

  // 1. 今すぐ同期
  const handleSyncNow = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setProgress({ step: 'resolving_config', message: '同期を開始中...' });
    setBannerMessage(null);

    try {
      const res = await executeFullSync({
        config: config ?? undefined,
        onProgress: (p) => setProgress(p),
      });

      setLastSyncAt(res.syncedAt);
      setBannerMessage({
        type: 'success',
        text: `同期が完了しました（送信: ${res.uploadedCount}枚、受信: ${res.downloadedCount}枚）。`,
      });

      if (onSyncComplete) {
        await onSyncComplete();
      }
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: `同期に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setIsSyncing(false);
      setProgress(null);
    }
  };

  // 2. サーバーから設定を再取得 (Pages Functions 自動取得)
  const handleFetchAuto = async () => {
    setIsFetchingAuto(true);
    setBannerMessage(null);
    setTestResult(null);

    try {
      const res = await fetchAutoSyncConfig();
      if (res.success && res.config) {
        setConfig(res.config);
        setGasUrlInput(res.config.gasUrl);
        setPassphraseInput(res.config.passphrase);
        setBannerMessage({
          type: 'success',
          text: 'Cloudflare Pages から同期設定を自動取得しました。',
        });
      } else {
        setBannerMessage({
          type: 'error',
          text: res.error || '設定の自動取得に失敗しました。手動で入力してください。',
        });
      }
    } finally {
      setIsFetchingAuto(false);
    }
  };

  // 3. 手動設定の保存
  const handleSaveManualConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = gasUrlInput.trim();
    const pass = passphraseInput.trim();

    if (!url || !pass) {
      setBannerMessage({
        type: 'error',
        text: 'GAS Web App URL と合言葉の両方を入力してください。',
      });
      return;
    }

    const newConfig: SyncConnectionConfig = {
      gasUrl: url,
      passphrase: pass,
      source: 'manual',
      updatedAt: new Date().toISOString(),
    };

    await saveSyncConfig(newConfig);
    setConfig(newConfig);
    setBannerMessage({
      type: 'success',
      text: '同期接続設定を端末内に保存しました。',
    });
  };

  // 4. 接続テスト (ping)
  const handleTestPing = async () => {
    const url = gasUrlInput.trim();
    const pass = passphraseInput.trim();

    if (!url || !pass) {
      setTestResult({
        ok: false,
        message: 'URL と合言葉を入力してからテストしてください。',
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const res = await testSyncConnection({
        gasUrl: url,
        passphrase: pass,
        source: config?.source || 'manual',
        updatedAt: new Date().toISOString(),
      });

      if (res.success && res.response) {
        const counts = res.response.counts;
        const countText = counts
          ? `（サーバー上: ボトル ${counts.bottlesActive}本、写真 ${counts.photosActive}枚）`
          : '';
        setTestResult({
          ok: true,
          message: `接続成功！${countText}`,
        });
      } else {
        setTestResult({
          ok: false,
          message: res.error || '接続テストに失敗しました。',
        });
      }
    } finally {
      setIsTesting(false);
    }
  };

  // 進捗パーセンテージ計算
  const getProgressPercent = (): number | null => {
    if (!progress || progress.current === undefined || progress.total === undefined || progress.total === 0) {
      return null;
    }
    return Math.min(100, Math.round((progress.current / progress.total) * 100));
  };

  const progressPercent = getProgressPercent();

  return (
    <div className={`space-y-4 ${className}`}>
      {/* 通知バナー */}
      {bannerMessage && (
        <div
          className={`p-4 rounded-2xl border text-sm whitespace-pre-line leading-relaxed flex items-start gap-3 shadow-sm ${
            bannerMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : bannerMessage.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-900'
              : 'bg-stone-50 border-stone-200 text-stone-900'
          }`}
          role="alert"
        >
          {bannerMessage.type === 'success' && (
            <span className="text-emerald-600 mt-0.5 shrink-0">
              <CheckIcon className="w-5 h-5" />
            </span>
          )}
          <div className="flex-1 font-medium">{bannerMessage.text}</div>
          <button
            type="button"
            onClick={() => setBannerMessage(null)}
            className="text-stone-400 hover:text-stone-700 min-h-touch min-w-touch flex items-center justify-center p-1 -mr-2 -mt-2"
            aria-label="バナーを閉じる"
          >
            ×
          </button>
        </div>
      )}

      {/* 常時表示: クラウド同期カード */}
      <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center justify-center shrink-0">
              <CloudIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-900">クラウド同期</h2>
              <p className="text-xs text-stone-500 mt-0.5">
                最終同期: <span className="font-medium text-stone-700">{formatSyncTime(lastSyncAt)}</span>
              </p>
            </div>
          </div>

          <div>
            {config ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                接続可能
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-stone-100 text-stone-600 border border-stone-200">
                未設定
              </span>
            )}
          </div>
        </div>

        {/* 同期実行中プログレス */}
        {isSyncing && progress && (
          <div className="p-3.5 bg-amber-50/70 border border-amber-200/80 rounded-xl space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-amber-950">
              <span className="flex items-center gap-2">
                <ArrowPathIcon className="w-4 h-4 animate-spin text-amber-700" />
                {progress.message}
              </span>
              {progressPercent !== null && <span>{progressPercent}%</span>}
            </div>

            {progressPercent !== null && (
              <div className="w-full bg-amber-200/50 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-amber-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* 今すぐ同期ボタン (幅100%, 最小高さ48px) */}
        <button
          type="button"
          onClick={handleSyncNow}
          disabled={isSyncing}
          className="w-full min-h-[48px] bg-stone-900 hover:bg-stone-800 active:bg-black disabled:bg-stone-400 text-white font-bold text-sm px-4 py-3 rounded-xl transition flex items-center justify-center gap-2.5 shadow-sm"
        >
          {isSyncing ? (
            <>
              <ArrowPathIcon className="w-5 h-5 animate-spin" />
              <span>同期中...</span>
            </>
          ) : (
            <>
              <ArrowPathIcon className="w-5 h-5 text-amber-400" />
              <span>今すぐ同期</span>
            </>
          )}
        </button>
      </div>

      {/* 折りたたみボタン: 同期設定・バックアップ・初期化 */}
      <button
        type="button"
        onClick={toggleSettings}
        className="w-full min-h-touch py-3 px-4 bg-white hover:bg-stone-50 active:bg-stone-100 rounded-xl border border-stone-200 shadow-sm flex items-center justify-between text-xs font-bold text-stone-700 transition"
      >
        <span className="flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-stone-500" />
          <span>⚙️ 同期設定・バックアップ・初期化を開く</span>
        </span>
        <span
          className={`transform transition-transform text-stone-400 ${
            isSettingsOpen ? 'rotate-180' : ''
          }`}
        >
          <ChevronDownIcon className="w-4 h-4" />
        </span>
      </button>

      {/* 折りたたみコンテンツ */}
      {isSettingsOpen && (
        <div className="space-y-4 pt-1">
          {/* 1. 同期接続設定カード */}
          <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold text-stone-900">同期接続設定 (GAS & 合言葉)</h3>
                <p className="text-xs text-stone-500 mt-0.5 leading-relaxed">
                  本人の Google アカウント上の GAS Web App と連携します。
                </p>
              </div>

              {config?.source && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">
                  {config.source === 'auto' ? '自動取得済' : '手動入力'}
                </span>
              )}
            </div>

            {/* 自動取得ボタン */}
            <div className="bg-stone-50 p-3 rounded-xl border border-stone-200 flex items-center justify-between gap-3">
              <div className="text-xs text-stone-600">
                <span className="font-bold text-stone-800 block">Cloudflare Pages から設定取得</span>
                <span>Access ログイン中ならワンタップで取得できます</span>
              </div>
              <button
                type="button"
                onClick={handleFetchAuto}
                disabled={isFetchingAuto || isSyncing}
                className="shrink-0 min-h-touch px-3 py-1.5 bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 font-bold text-xs rounded-lg transition disabled:opacity-50"
              >
                {isFetchingAuto ? '取得中...' : 'サーバーから再取得'}
              </button>
            </div>

            {/* 手動入力フォーム */}
            <form onSubmit={handleSaveManualConfig} className="space-y-3">
              <div>
                <label htmlFor="gas-url-input" className="block text-xs font-bold text-stone-700 mb-1">
                  GAS Web App URL
                </label>
                <input
                  id="gas-url-input"
                  type="url"
                  value={gasUrlInput}
                  onChange={(e) => setGasUrlInput(e.target.value)}
                  placeholder="https://script.google.com/macros/s/.../exec"
                  className="w-full text-xs font-mono px-3 py-2.5 rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-800"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="passphrase-input" className="block text-xs font-bold text-stone-700">
                    合言葉 (SYNC_PASSPHRASE)
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowPassphrase((prev) => !prev)}
                    className="text-[11px] text-stone-500 hover:text-stone-800 p-1"
                  >
                    {showPassphrase ? '隠す' : '表示'}
                  </button>
                </div>
                <input
                  id="passphrase-input"
                  type={showPassphrase ? 'text' : 'password'}
                  value={passphraseInput}
                  onChange={(e) => setPassphraseInput(e.target.value)}
                  placeholder="合言葉を入力"
                  className="w-full text-xs font-mono px-3 py-2.5 rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-800"
                />
              </div>

              {/* テスト結果表示 */}
              {testResult && (
                <div
                  className={`p-3 rounded-lg text-xs leading-relaxed ${
                    testResult.ok
                      ? 'bg-emerald-50 text-emerald-900 border border-emerald-200'
                      : 'bg-rose-50 text-rose-900 border border-rose-200'
                  }`}
                >
                  {testResult.message}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleTestPing}
                  disabled={isTesting || !gasUrlInput || !passphraseInput}
                  className="min-h-touch py-2 px-3 bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-300 font-bold text-xs rounded-lg transition disabled:opacity-50"
                >
                  {isTesting ? 'テスト中...' : '接続テスト (ping)'}
                </button>
                <button
                  type="submit"
                  disabled={!gasUrlInput || !passphraseInput}
                  className="min-h-touch py-2 px-3 bg-stone-900 hover:bg-stone-800 text-white font-bold text-xs rounded-lg transition disabled:opacity-50"
                >
                  設定を保存
                </button>
              </div>
            </form>
          </div>

          {/* 外部から渡されたバックアップ・サンプル初期化ブロック */}
          {children}
        </div>
      )}
    </div>
  );
};
