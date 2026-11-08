import React from 'react';
import { BottleGroup } from '../domain/sortAndGroup';
import { BottleRecord } from '../types/sake';
import { StatusBadge, CategoryBadge } from './Badge';
import { calculateOpenedDays } from '../domain/bottleUtils';
import { CloseIcon, ChevronRightIcon } from './Icons';

export interface GroupDetailSheetProps {
  group: BottleGroup | null;
  onClose: () => void;
  onSelectBottle: (bottle: BottleRecord) => void;
}

export const GroupDetailSheet: React.FC<GroupDetailSheetProps> = ({
  group,
  onClose,
  onSelectBottle,
}) => {
  if (!group) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4 transition-opacity"
      role="dialog"
      aria-modal="true"
      aria-label="同一銘柄の個別一覧"
    >
      <div className="bg-white w-full max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in slide-in-from-bottom-6 duration-200">
        {/* シートヘッダー */}
        <div className="p-4 sm:p-5 border-b border-stone-200 flex items-start justify-between gap-3 bg-stone-50">
          <div>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <CategoryBadge category={group.category} />
              {group.vintageYear !== null && (
                <span className="text-xs font-semibold text-stone-600 bg-stone-200 px-2 py-0.5 rounded">
                  {group.vintageYear}年
                </span>
              )}
              {group.volumeMl !== null && (
                <span className="text-xs text-stone-500 font-medium">
                  {group.volumeMl}ml
                </span>
              )}
              <span className="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                全{group.bottles.length}本
              </span>
            </div>
            <h2 className="text-lg font-bold text-stone-900 leading-tight">
              {group.name}
            </h2>
            <p className="text-xs text-stone-500 mt-1">
              確認したい個体を選択してください（1本ずつ詳細を表示できます）
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="min-h-touch min-w-touch p-2 -mr-2 -mt-1 text-stone-400 hover:text-stone-700 transition flex items-center justify-center rounded-full hover:bg-stone-200"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        {/* 個体リスト */}
        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          {group.bottles.map((bottle, index) => {
            const openedDays = calculateOpenedDays(bottle);
            return (
              <button
                key={bottle.id}
                type="button"
                onClick={() => {
                  onSelectBottle(bottle);
                }}
                className="w-full min-h-touch text-left p-3.5 rounded-2xl border border-stone-200 hover:border-stone-400 bg-white hover:bg-stone-50/80 transition active:scale-[0.99] flex items-center justify-between gap-3 shadow-sm"
              >
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-stone-400">
                      #{index + 1}
                    </span>
                    <StatusBadge status={bottle.status} />
                    {bottle.status === 'opened' && bottle.openedDate && openedDays !== null && (
                      <span className="text-xs text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded">
                        開封から{openedDays}日
                      </span>
                    )}
                  </div>

                  <div className="text-xs text-stone-600 flex flex-wrap gap-x-3 gap-y-1">
                    {bottle.purchaseInfo.purchaseDate && (
                      <span>購入日: {bottle.purchaseInfo.purchaseDate}</span>
                    )}
                    {bottle.purchaseInfo.purchasePriceYen !== null && (
                      <span>購入価格: ¥{bottle.purchaseInfo.purchasePriceYen.toLocaleString()}</span>
                    )}
                    {bottle.openedDate && (
                      <span>開封日: {bottle.openedDate}</span>
                    )}
                  </div>

                  {bottle.tastingNote && (
                    <p className="text-xs text-stone-500 italic line-clamp-1">
                      メモ: {bottle.tastingNote}
                    </p>
                  )}
                </div>

                <div className="text-stone-400 shrink-0">
                  <ChevronRightIcon className="w-5 h-5" />
                </div>
              </button>
            );
          })}
        </div>

        {/* シートフッター */}
        <div className="p-3 bg-stone-50 border-t border-stone-200 text-center">
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
