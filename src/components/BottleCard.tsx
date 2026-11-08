import React from 'react';
import { BottleGroup } from '../domain/sortAndGroup';
import { PhotoRecord } from '../types/sake';
import { StatusBadge, GroupCountBadge, CategoryBadge } from './Badge';
import { BottlePlaceholderIcon } from './Icons';

export interface BottleCardProps {
  group: BottleGroup;
  photo?: PhotoRecord;
  onClick: (group: BottleGroup) => void;
}

export const BottleCard: React.FC<BottleCardProps> = ({ group, photo, onClick }) => {
  return (
    <button
      type="button"
      onClick={() => onClick(group)}
      className="flex flex-col text-left bg-white rounded-2xl overflow-hidden border border-stone-200 hover:border-stone-400 shadow-sm hover:shadow transition active:scale-[0.98] w-full min-h-touch group"
    >
      {/* 写真エリアまたはプレースホルダー */}
      <div className="relative aspect-square w-full bg-stone-150 overflow-hidden flex items-center justify-center">
        {photo ? (
          <img
            src={photo.dataUrl}
            alt={group.name}
            className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
            loading="lazy"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-stone-400 p-4 text-center">
            <BottlePlaceholderIcon className="w-12 h-12 stroke-[1.25] text-stone-300" />
            <span className="text-[11px] font-medium text-stone-500 mt-1 line-clamp-1">
              {group.name}
            </span>
          </div>
        )}

        {/* 状態バッジ (左上) */}
        <div className="absolute top-2 left-2 flex gap-1 items-center">
          <StatusBadge status={group.priorityStatus} className="shadow-sm" />
        </div>

        {/* 本数バッジ (右上、2本以上の場合) */}
        {group.bottles.length >= 2 && (
          <div className="absolute top-2 right-2">
            <GroupCountBadge count={group.bottles.length} />
          </div>
        )}
      </div>

      {/* テキスト・属性エリア */}
      <div className="p-3 flex-1 flex flex-col justify-between space-y-1.5">
        <div>
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <CategoryBadge category={group.category} />
            {group.vintageYear !== null && (
              <span className="text-[11px] font-semibold text-stone-600 bg-stone-100 px-1.5 py-0.5 rounded">
                {group.vintageYear}年
              </span>
            )}
            {group.volumeMl !== null && (
              <span className="text-[11px] text-stone-500">
                {group.volumeMl}ml
              </span>
            )}
          </div>
          <h3 className="font-bold text-stone-900 text-sm leading-snug line-clamp-2">
            {group.name}
          </h3>
        </div>

        {/* 複数本グループ時の補助ラベル */}
        {group.bottles.length >= 2 && (
          <div className="pt-1 text-[11px] text-amber-700 font-medium">
            全{group.bottles.length}本（タップして展開）
          </div>
        )}
      </div>
    </button>
  );
};
