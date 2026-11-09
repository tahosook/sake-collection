import React, { useState, useMemo } from 'react';
import { BottleRecord, PhotoRecord, SakeCategory, SAKE_CATEGORIES } from '../types/sake';
import { CategoryBadge, StatusBadge } from './Badge';
import { CloseIcon, SearchIcon, BottlePlaceholderIcon, ArrowPathIcon } from './Icons';

export interface ReuseBottlePickerModalProps {
  isOpen: boolean;
  allBottles: BottleRecord[];
  photos: PhotoRecord[];
  onClose: () => void;
  onSelectBottle: (bottle: BottleRecord, copyPhotos: boolean) => void;
}

export const ReuseBottlePickerModal: React.FC<ReuseBottlePickerModalProps> = ({
  isOpen,
  allBottles,
  photos,
  onClose,
  onSelectBottle,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<SakeCategory | 'all'>('all');
  const [copyPhotos, setCopyPhotos] = useState<boolean>(true);

  // 有効な（未削除の）ボトルのみを対象とし、更新日時降順でソート
  const activeBottles = useMemo(() => {
    return allBottles
      .filter((b) => !b.deleted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [allBottles]);

  // 検索・絞り込み
  const filteredBottles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeBottles.filter((b) => {
      if (selectedCategory !== 'all' && b.category !== selectedCategory) {
        return false;
      }
      if (q) {
        const matchName = b.name.toLowerCase().includes(q);
        const matchPlace = b.purchaseInfo.purchasePlace.toLowerCase().includes(q);
        const matchNote = b.tastingNote.toLowerCase().includes(q);
        return matchName || matchPlace || matchNote;
      }
      return true;
    });
  }, [activeBottles, searchQuery, selectedCategory]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="流用元の銘柄を選択"
    >
      <div className="bg-white w-full max-w-lg min-h-screen sm:min-h-0 sm:max-h-[90vh] sm:rounded-3xl flex flex-col shadow-2xl overflow-hidden animate-in fade-in duration-200">
        {/* ヘッダー */}
        <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-stone-100 rounded-lg text-stone-700">
              <ArrowPathIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-900">
                既存銘柄から流用して登録
              </h2>
              <p className="text-[11px] text-stone-500">
                過去のボトルの属性・解説・相場目安を引き継ぎます
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="min-h-touch min-w-touch p-2 -mr-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-full transition flex items-center justify-center"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        {/* コントロール部（検索・カテゴリ・写真引き継ぎ設定） */}
        <div className="p-4 bg-stone-50 border-b border-stone-200 space-y-3">
          {/* 写真引き継ぎトグル */}
          <div className="p-3 bg-white rounded-xl border border-stone-200 shadow-sm">
            <label className="min-h-touch flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={copyPhotos}
                onChange={(e) => setCopyPhotos(e.target.checked)}
                className="w-5 h-5 rounded text-stone-900 focus:ring-0 border-stone-300 cursor-pointer"
              />
              <div>
                <span className="text-xs font-bold text-stone-800 block">
                  写真も引き継ぐ（新しい写真として複製）
                </span>
                <span className="text-[11px] text-stone-500 block">
                  チェックを外すと属性・解説のみを引き継ぎ、写真は引き継ぎません
                </span>
              </div>
            </label>
          </div>

          {/* 検索入力 */}
          <div className="relative">
            <SearchIcon className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="銘柄名や購入店舗で絞り込み..."
              className="w-full min-h-touch pl-9 pr-4 py-2 bg-white border border-stone-300 focus:border-stone-900 rounded-xl text-xs outline-none shadow-sm transition"
            />
          </div>

          {/* 種類ピルボタン */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            <button
              type="button"
              onClick={() => setSelectedCategory('all')}
              className={`min-h-touch px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition ${
                selectedCategory === 'all'
                  ? 'bg-stone-900 text-white'
                  : 'bg-white text-stone-600 border border-stone-200 hover:bg-stone-100'
              }`}
            >
              すべて ({activeBottles.length})
            </button>
            {SAKE_CATEGORIES.map((cat) => {
              const count = activeBottles.filter((b) => b.category === cat).length;
              if (count === 0) return null;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`min-h-touch px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition ${
                    selectedCategory === cat
                      ? 'bg-stone-900 text-white'
                      : 'bg-white text-stone-600 border border-stone-200 hover:bg-stone-100'
                  }`}
                >
                  {cat} ({count})
                </button>
              );
            })}
          </div>
        </div>

        {/* ボトル一覧 */}
        <div className="p-4 space-y-2.5 overflow-y-auto flex-1">
          {filteredBottles.length === 0 ? (
            <div className="py-12 text-center space-y-2 text-stone-400">
              <p className="text-xs">流用できるお酒が見つかりませんでした。</p>
            </div>
          ) : (
            filteredBottles.map((bottle) => {
              // 代表写真の取得
              const primaryId = bottle.primaryPhotoId ?? bottle.photoIds[0];
              const photo = primaryId
                ? photos.find((p) => p.id === primaryId)
                : undefined;

              return (
                <div
                  key={bottle.id}
                  className="p-3 bg-white hover:bg-stone-50 rounded-2xl border border-stone-200 shadow-sm flex items-center justify-between gap-3 transition"
                >
                  {/* サムネイルと情報 */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-14 h-14 rounded-xl bg-stone-100 border border-stone-200 overflow-hidden flex-shrink-0 flex items-center justify-center">
                      {photo?.dataUrl ? (
                        <img
                          src={photo.dataUrl}
                          alt={bottle.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <BottlePlaceholderIcon className="w-7 h-7 text-stone-400" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <CategoryBadge category={bottle.category} />
                        <StatusBadge status={bottle.status} />
                      </div>
                      <h3 className="text-xs font-bold text-stone-900 truncate">
                        {bottle.name}
                      </h3>
                      <div className="text-[11px] text-stone-500 flex gap-2">
                        {bottle.volumeMl && <span>{bottle.volumeMl}ml</span>}
                        {bottle.abv && <span>{bottle.abv}%</span>}
                        {bottle.photoIds.length > 0 && (
                          <span>写真 {bottle.photoIds.length}枚</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 流用実行ボタン */}
                  <button
                    type="button"
                    onClick={() => onSelectBottle(bottle, copyPhotos)}
                    className="min-h-touch px-3.5 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold rounded-xl whitespace-nowrap transition shadow-sm"
                  >
                    この銘柄を流用
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* フッター */}
        <div className="p-3 bg-stone-50 border-t border-stone-200">
          <button
            type="button"
            onClick={onClose}
            className="w-full min-h-touch bg-stone-200 hover:bg-stone-300 text-stone-800 font-semibold text-xs rounded-xl transition"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
};
