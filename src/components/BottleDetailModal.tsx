import React, { useState, useEffect } from 'react';
import { BottleRecord, PhotoRecord, BottleStatus } from '../types/sake';
import { StatusBadge, CategoryBadge } from './Badge';
import { STATUS_LABELS } from '../domain/status';
import { CATEGORY_ATTRIBUTE_LABELS } from '../domain/categories';
import { calculateOpenedDays, getTodayDateString } from '../domain/bottleUtils';
import {
  CloseIcon,
  HeartIcon,
  EditIcon,
  TrashIcon,
  BottlePlaceholderIcon,
} from './Icons';

export interface BottleDetailModalProps {
  bottle: BottleRecord | null;
  photos: PhotoRecord[];
  onClose: () => void;
  onEdit: (bottle: BottleRecord) => void;
  onDelete: (bottleId: string) => Promise<void>;
  onChangeStatus: (
    bottleId: string,
    newStatus: BottleStatus,
    dateOverride?: string | null
  ) => Promise<BottleRecord | null>;
  onToggleWantToBuyAgain: (bottle: BottleRecord) => Promise<void>;
}

export const BottleDetailModal: React.FC<BottleDetailModalProps> = ({
  bottle,
  photos,
  onClose,
  onEdit,
  onDelete,
  onChangeStatus,
  onToggleWantToBuyAgain,
}) => {
  const [activePhotoIndex, setActivePhotoIndex] = useState<number>(0);
  const [isChangingStatus, setIsChangingStatus] = useState<boolean>(false);
  const [selectedNewStatus, setSelectedNewStatus] = useState<BottleStatus | null>(null);
  const [statusDateInput, setStatusDateInput] = useState<string>(getTodayDateString());
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // ボトルが切り替わった場合（別ボトル表示時）に内部状態をリセット
  useEffect(() => {
    setActivePhotoIndex(0);
    setIsChangingStatus(false);
    setSelectedNewStatus(null);
    setStatusDateInput(getTodayDateString());
  }, [bottle?.id]);

  if (!bottle) return null;

  // 写真の解決
  const bottlePhotos = bottle.photoIds
    .map((id) => photos.find((p) => p.id === id))
    .filter((p): p is PhotoRecord => p !== undefined);

  const primaryPhotoId = bottle.primaryPhotoId ?? bottle.photoIds[0];
  const activePhoto = bottlePhotos[activePhotoIndex] ?? bottlePhotos[0];

  // 開封日数の計算
  const openedDays = calculateOpenedDays(bottle);

  // 状態変更の確定処理
  const handleConfirmStatusChange = async () => {
    if (!selectedNewStatus) return;
    const dateOverride = selectedNewStatus === 'unopened' ? null : (statusDateInput || getTodayDateString());
    await onChangeStatus(bottle.id, selectedNewStatus, dateOverride);
    setIsChangingStatus(false);
    setSelectedNewStatus(null);
  };

  // 削除処理
  const handleDeleteBottle = async () => {
    if (window.confirm(`「${bottle.name}」をコレクションから削除しますか？`)) {
      setIsDeleting(true);
      try {
        await onDelete(bottle.id);
        onClose();
      } finally {
        setIsDeleting(false);
      }
    }
  };

  // 種類別属性の取得
  const attributeLabels = CATEGORY_ATTRIBUTE_LABELS[bottle.category] ?? {};
  const attributeEntries = Object.entries(bottle.categoryAttributes).filter(
    ([, value]) => value !== undefined && value !== null && value !== ''
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="ボトル詳細"
    >
      <div className="bg-white w-full max-w-lg min-h-screen sm:min-h-0 sm:max-h-[92vh] sm:rounded-3xl flex flex-col shadow-2xl overflow-hidden animate-in fade-in duration-200">
        {/* モーダルヘッダー */}
        <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CategoryBadge category={bottle.category} />
            <StatusBadge status={bottle.status} />
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onToggleWantToBuyAgain(bottle)}
              aria-label={bottle.wantToBuyAgain ? '「また買いたい」を取り消す' : '「また買いたい」に登録'}
              className={`min-h-touch min-w-touch p-2 rounded-full transition flex items-center justify-center ${
                bottle.wantToBuyAgain
                  ? 'text-rose-500 hover:bg-rose-50'
                  : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100'
              }`}
            >
              <HeartIcon filled={bottle.wantToBuyAgain} className="w-6 h-6" />
            </button>
            <button
              type="button"
              onClick={() => onEdit(bottle)}
              aria-label="編集"
              className="min-h-touch min-w-touch p-2 text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded-full transition flex items-center justify-center"
            >
              <EditIcon className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={handleDeleteBottle}
              disabled={isDeleting}
              aria-label="削除"
              className="min-h-touch min-w-touch p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-full transition flex items-center justify-center"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="min-h-touch min-w-touch p-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-full transition flex items-center justify-center"
            >
              <CloseIcon className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* スクロール可能コンテンツ */}
        <div className="p-4 sm:p-6 space-y-6 overflow-y-auto flex-1">
          {/* 1. 写真ビューア */}
          <div className="space-y-2">
            <div className="relative aspect-square w-full bg-stone-100 rounded-2xl overflow-hidden border border-stone-200 flex items-center justify-center">
              {activePhoto ? (
                <img
                  src={activePhoto.dataUrl}
                  alt={bottle.name}
                  className="w-full h-full object-contain bg-stone-900/5"
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-stone-300">
                  <BottlePlaceholderIcon className="w-20 h-20" />
                  <span className="text-xs text-stone-400 mt-2 font-medium">写真なし</span>
                </div>
              )}

              {/* 代表写真バッジ */}
              {activePhoto && activePhoto.id === primaryPhotoId && (
                <div className="absolute top-3 left-3 bg-stone-900/80 backdrop-blur text-white text-[11px] font-bold px-2 py-0.5 rounded-full shadow">
                  代表写真
                </div>
              )}
            </div>

            {/* サムネイル一覧（複数枚ある場合） */}
            {bottlePhotos.length > 1 && (
              <div className="flex gap-2 overflow-x-auto py-1">
                {bottlePhotos.map((p, idx) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActivePhotoIndex(idx)}
                    className={`relative w-16 h-16 min-h-touch min-w-touch rounded-xl overflow-hidden border-2 transition shrink-0 ${
                      activePhotoIndex === idx
                        ? 'border-stone-900 shadow'
                        : 'border-transparent opacity-60 hover:opacity-100'
                    }`}
                  >
                    <img src={p.dataUrl} alt={`写真 ${idx + 1}`} className="w-full h-full object-cover" />
                    {p.id === primaryPhotoId && (
                      <span className="absolute bottom-0 inset-x-0 bg-stone-900/80 text-[9px] text-white font-bold text-center">
                        代表
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 2. 銘柄名と基本スペック */}
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-stone-900 leading-snug">
              {bottle.name}
            </h1>
            <div className="flex items-center gap-3 mt-2 text-sm text-stone-600 flex-wrap">
              {bottle.volumeMl !== null && <span>容量: {bottle.volumeMl}ml</span>}
              {bottle.abv !== null && <span>度数: {bottle.abv}%</span>}
              {bottle.category === 'ワイン' && bottle.categoryAttributes.vintageYear && (
                <span>ヴィンテージ: {bottle.categoryAttributes.vintageYear}年</span>
              )}
            </div>
          </div>

          {/* 3. 状態・日付と状態変更 UI */}
          <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                状態と日付
              </h2>
              <button
                type="button"
                onClick={() => {
                  setIsChangingStatus(!isChangingStatus);
                  setSelectedNewStatus(null);
                }}
                className="min-h-touch text-xs font-bold text-stone-800 hover:text-stone-950 underline flex items-center"
              >
                {isChangingStatus ? 'キャンセル' : '状態を変更する'}
              </button>
            </div>

            {/* 日付表示（開封日数の条件付き補助表示含む） */}
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between py-1 border-b border-stone-200">
                <span className="text-stone-500">現在の状態</span>
                <span className="font-semibold text-stone-800">{STATUS_LABELS[bottle.status]}</span>
              </div>

              {bottle.openedDate && (
                <div className="flex items-center justify-between py-1 border-b border-stone-200">
                  <span className="text-stone-500">開封日</span>
                  <span className="font-semibold text-stone-800">
                    {bottle.openedDate}
                    {/* 開封日数補助表示: opened かつ openedDate がある場合のみ表示 */}
                    {bottle.status === 'opened' && openedDays !== null && (
                      <span className="ml-1.5 text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded">
                        （開封から{openedDays}日）
                      </span>
                    )}
                  </span>
                </div>
              )}

              {bottle.finishedDate && (
                <div className="flex items-center justify-between py-1 border-b border-stone-200">
                  <span className="text-stone-500">飲み切り日</span>
                  <span className="font-semibold text-stone-800">{bottle.finishedDate}</span>
                </div>
              )}

              {bottle.disposedDate && (
                <div className="flex items-center justify-between py-1 border-b border-stone-200">
                  <span className="text-stone-500">手放した日</span>
                  <span className="font-semibold text-stone-800">{bottle.disposedDate}</span>
                </div>
              )}
            </div>

            {/* 状態変更フォーム（展開時） */}
            {isChangingStatus && (
              <div className="pt-2 border-t border-stone-200 space-y-3">
                <label className="block text-xs font-bold text-stone-700">
                  新しい状態を選択:
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(['unopened', 'opened', 'finished', 'disposed'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => {
                        setSelectedNewStatus(st);
                        if (st === 'opened' && !bottle.openedDate) {
                          setStatusDateInput(getTodayDateString());
                        }
                      }}
                      className={`min-h-touch p-2.5 rounded-xl text-xs font-semibold border transition ${
                        selectedNewStatus === st
                          ? 'bg-stone-900 text-white border-stone-900'
                          : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-100'
                      }`}
                    >
                      {STATUS_LABELS[st]}
                    </button>
                  ))}
                </div>

                {selectedNewStatus && selectedNewStatus !== 'unopened' && (
                  <div>
                    <label className="block text-xs font-medium text-stone-600 mb-1">
                      {selectedNewStatus === 'opened'
                        ? '開封日:'
                        : selectedNewStatus === 'finished'
                        ? '飲み切り日:'
                        : '手放した日:'}
                    </label>
                    <input
                      type="date"
                      value={statusDateInput}
                      onChange={(e) => setStatusDateInput(e.target.value)}
                      className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm"
                    />
                  </div>
                )}

                {selectedNewStatus === 'unopened' && (
                  <p className="text-xs text-amber-700 bg-amber-50 p-2 rounded-lg">
                    未開封に戻すと、開封日・飲み切り日・手放した日はすべてクリア（未設定）になります。
                  </p>
                )}

                {selectedNewStatus && (
                  <button
                    type="button"
                    onClick={handleConfirmStatusChange}
                    className="w-full min-h-touch bg-stone-900 text-white font-bold text-sm rounded-xl hover:bg-stone-800 transition"
                  >
                    状態の変更を保存する
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 4. 種類別追加属性 */}
          {attributeEntries.length > 0 && (
            <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200 space-y-2">
              <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                {bottle.category}の属性
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {attributeEntries.map(([key, val]) => (
                  <div key={key}>
                    <dt className="text-xs text-stone-500">{attributeLabels[key] ?? key}</dt>
                    <dd className="font-semibold text-stone-800">{String(val)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* 5. 感想メモ */}
          {bottle.tastingNote && (
            <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200 space-y-1.5">
              <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                感想・メモ
              </h2>
              <p className="text-sm text-stone-800 whitespace-pre-wrap leading-relaxed">
                {bottle.tastingNote}
              </p>
            </div>
          )}

          {/* 6. 解説（4部構成）と出典 */}
          {bottle.description && (
            <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200 space-y-3">
              <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                お酒の解説
              </h2>
              <div className="space-y-3 text-sm">
                {bottle.description.summary && (
                  <div>
                    <span className="text-xs font-bold text-stone-600 block">① ひとことで</span>
                    <p className="text-stone-800 mt-0.5">{bottle.description.summary}</p>
                  </div>
                )}
                {bottle.description.tasteProfile && (
                  <div>
                    <span className="text-xs font-bold text-stone-600 block">② 味わい</span>
                    <p className="text-stone-800 mt-0.5">{bottle.description.tasteProfile}</p>
                  </div>
                )}
                {bottle.description.background && (
                  <div>
                    <span className="text-xs font-bold text-stone-600 block">③ 背景・歴史</span>
                    <p className="text-stone-800 mt-0.5">{bottle.description.background}</p>
                  </div>
                )}
                {bottle.description.servingSuggestion && (
                  <div>
                    <span className="text-xs font-bold text-stone-600 block">④ おすすめの飲み方</span>
                    <p className="text-stone-800 mt-0.5">{bottle.description.servingSuggestion}</p>
                  </div>
                )}
              </div>

              {bottle.sources.length > 0 && (
                <div className="pt-2 border-t border-stone-200 text-xs">
                  <span className="font-bold text-stone-500 block mb-1">出典:</span>
                  <ul className="space-y-1">
                    {bottle.sources.map((src, idx) => (
                      <li key={idx}>
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-stone-700 underline hover:text-stone-900 break-all"
                        >
                          {src.title ?? src.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* 7. 購入情報と相場目安（構造分離の徹底） */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 購入情報 */}
            <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200 space-y-2">
              <h2 className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                購入情報
              </h2>
              <div className="space-y-1.5 text-xs text-stone-700">
                <div>
                  <span className="text-stone-500 block">購入価格:</span>
                  <span className="text-sm font-bold text-stone-900">
                    {bottle.purchaseInfo.purchasePriceYen !== null
                      ? `¥${bottle.purchaseInfo.purchasePriceYen.toLocaleString()}`
                      : '未設定'}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block">購入日:</span>
                  <span className="font-medium">
                    {bottle.purchaseInfo.purchaseDate ?? '未入力'}
                  </span>
                </div>
                <div>
                  <span className="text-stone-500 block">購入場所:</span>
                  <span className="font-medium">
                    {bottle.purchaseInfo.purchasePlace || '未入力'}
                  </span>
                </div>
              </div>
            </div>

            {/* 相場目安（購入価格とは別欄） */}
            <div className="bg-amber-50/60 p-4 rounded-2xl border border-amber-200 space-y-2">
              <h2 className="text-xs font-bold text-amber-800 uppercase tracking-wider">
                相場目安（市場参考値）
              </h2>
              {bottle.referencePrice ? (
                <div className="space-y-1.5 text-xs text-amber-900">
                  <div>
                    <span className="text-amber-700 block">推定相場:</span>
                    <span className="text-sm font-bold text-amber-950">
                      {bottle.referencePrice.estimatedPriceYen !== null
                        ? `¥${bottle.referencePrice.estimatedPriceYen.toLocaleString()}`
                        : '未取得'}
                    </span>
                  </div>
                  <div>
                    <span className="text-amber-700 block">取得日:</span>
                    <span className="font-medium">
                      {bottle.referencePrice.fetchedDate ?? '未記録'}
                    </span>
                  </div>
                  {bottle.referencePrice.note && (
                    <div className="text-[11px] text-amber-800 italic">
                      補足: {bottle.referencePrice.note}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-stone-400 py-1">相場目安データはありません</p>
              )}
            </div>
          </div>
        </div>

        {/* モーダルフッター */}
        <div className="p-3 bg-stone-50 border-t border-stone-200 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="w-full min-h-touch bg-stone-200 hover:bg-stone-300 text-stone-800 font-semibold text-sm rounded-xl transition"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
