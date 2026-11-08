import React from 'react';
import { BottleRecord, PhotoRecord } from '../types/sake';
import { StatusBadge, CategoryBadge } from './Badge';
import { BottlePlaceholderIcon, HeartIcon, ChevronRightIcon } from './Icons';

export interface BottleHistoryListProps {
  bottles: BottleRecord[];
  photos: PhotoRecord[];
  onSelectBottle: (bottle: BottleRecord) => void;
  emptyMessage?: string;
  type: 'finished' | 'disposed';
}

export const BottleHistoryList: React.FC<BottleHistoryListProps> = ({
  bottles,
  photos,
  onSelectBottle,
  emptyMessage = '記録がありません',
  type,
}) => {
  const photoMap = new Map(photos.map((p) => [p.id, p]));

  // 日付の降順でソート
  const sortedBottles = [...bottles].sort((a, b) => {
    const dateA =
      type === 'finished'
        ? a.finishedDate ?? a.updatedAt.slice(0, 10)
        : a.disposedDate ?? a.updatedAt.slice(0, 10);
    const dateB =
      type === 'finished'
        ? b.finishedDate ?? b.updatedAt.slice(0, 10)
        : b.disposedDate ?? b.updatedAt.slice(0, 10);
    return dateB.localeCompare(dateA);
  });

  if (sortedBottles.length === 0) {
    return (
      <div className="py-16 text-center text-stone-500">
        <p className="text-sm font-medium">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {sortedBottles.map((bottle) => {
        const primaryPhotoId = bottle.primaryPhotoId ?? bottle.photoIds[0];
        const photo = primaryPhotoId ? photoMap.get(primaryPhotoId) : undefined;
        const displayDate =
          type === 'finished' ? bottle.finishedDate : bottle.disposedDate;

        return (
          <button
            key={bottle.id}
            type="button"
            onClick={() => onSelectBottle(bottle)}
            className="w-full min-h-touch text-left p-3 bg-white rounded-2xl border border-stone-200 hover:border-stone-400 shadow-sm hover:shadow transition active:scale-[0.99] flex items-center gap-3.5"
          >
            {/* サムネイル */}
            <div className="w-16 h-16 rounded-xl bg-stone-100 overflow-hidden shrink-0 flex items-center justify-center border border-stone-200">
              {photo ? (
                <img
                  src={photo.dataUrl}
                  alt={bottle.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <BottlePlaceholderIcon className="w-8 h-8 text-stone-300" />
              )}
            </div>

            {/* 本文 */}
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <CategoryBadge category={bottle.category} />
                <StatusBadge status={bottle.status} />
                {displayDate && (
                  <span className="text-[11px] text-stone-500">
                    {type === 'finished' ? '飲み切り日: ' : '手放した日: '}
                    {displayDate}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <h3 className="font-bold text-stone-900 text-sm truncate flex-1">
                  {bottle.name}
                </h3>
                {bottle.wantToBuyAgain && (
                  <span className="text-rose-500 shrink-0" title="また買いたい">
                    <HeartIcon filled className="w-4 h-4" />
                  </span>
                )}
              </div>

              {bottle.tastingNote && (
                <p className="text-xs text-stone-500 line-clamp-1 italic">
                  {bottle.tastingNote}
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
  );
};
