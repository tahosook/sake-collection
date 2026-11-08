import React from 'react';
import { SAKE_CATEGORIES, SakeCategory, BottleStatus } from '../types/sake';
import { SearchIcon, CloseIcon } from './Icons';

export interface SearchBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedCategory: SakeCategory | 'all';
  onCategoryChange: (category: SakeCategory | 'all') => void;
  selectedStatus?: BottleStatus | 'all';
  onStatusChange?: (status: BottleStatus | 'all') => void;
  showStatusFilter?: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  searchQuery,
  onSearchChange,
  selectedCategory,
  onCategoryChange,
  selectedStatus = 'all',
  onStatusChange,
  showStatusFilter = false,
}) => {
  return (
    <div className="space-y-2.5">
      {/* 検索入力欄 */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-stone-400">
          <SearchIcon className="w-5 h-5" />
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="銘柄名、蔵元、産地、品種などで検索..."
          className="w-full min-h-touch pl-10 pr-10 py-2 bg-stone-100 hover:bg-stone-150 focus:bg-white border border-transparent focus:border-stone-400 rounded-xl text-sm text-stone-900 placeholder-stone-500 transition outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="検索キーワードをクリア"
            className="absolute inset-y-0 right-0 pr-3 flex items-center min-w-touch justify-center text-stone-400 hover:text-stone-600 transition"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* 状態フィルタ（すべて / 開封済みのみ / 未開封のみ） */}
      {showStatusFilter && onStatusChange && (
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => onStatusChange('all')}
            className={`min-h-touch px-3 py-1.5 rounded-lg font-medium transition ${
              selectedStatus === 'all'
                ? 'bg-stone-900 text-white'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            すべての状態
          </button>
          <button
            type="button"
            onClick={() => onStatusChange('opened')}
            className={`min-h-touch px-3 py-1.5 rounded-lg font-medium transition ${
              selectedStatus === 'opened'
                ? 'bg-emerald-600 text-white'
                : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
            }`}
          >
            開封済みのみ
          </button>
          <button
            type="button"
            onClick={() => onStatusChange('unopened')}
            className={`min-h-touch px-3 py-1.5 rounded-lg font-medium transition ${
              selectedStatus === 'unopened'
                ? 'bg-stone-800 text-white'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            未開封のみ
          </button>
        </div>
      )}

      {/* 種類フィルタチップ（横スクロール） */}
      <div className="overflow-x-auto no-scrollbar -mx-4 px-4 py-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onCategoryChange('all')}
          className={`min-h-touch whitespace-nowrap px-3.5 py-1.5 rounded-full text-xs font-semibold transition shrink-0 ${
            selectedCategory === 'all'
              ? 'bg-stone-900 text-white shadow-sm'
              : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-200'
          }`}
        >
          すべての種類
        </button>
        {SAKE_CATEGORIES.map((cat) => {
          const isSelected = selectedCategory === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => onCategoryChange(cat)}
              className={`min-h-touch whitespace-nowrap px-3.5 py-1.5 rounded-full text-xs font-semibold transition shrink-0 ${
                isSelected
                  ? 'bg-stone-900 text-white shadow-sm'
                  : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-200'
              }`}
            >
              {cat}
            </button>
          );
        })}
      </div>
    </div>
  );
};
