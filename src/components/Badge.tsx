import React from 'react';
import { BottleStatus, SakeCategory } from '../types/sake';
import { STATUS_LABELS } from '../domain/status';

export interface StatusBadgeProps {
  status: BottleStatus;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '' }) => {
  const colorMap: Record<BottleStatus, string> = {
    unopened: 'bg-stone-100 text-stone-800 border-stone-300',
    opened: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    finished: 'bg-blue-100 text-blue-800 border-blue-300',
    disposed: 'bg-rose-100 text-rose-800 border-rose-300',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${colorMap[status]} ${className}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
};

export interface CategoryBadgeProps {
  category: SakeCategory;
  className?: string;
}

const CATEGORY_COLOR_MAP: Record<SakeCategory, string> = {
  日本酒: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  ワイン: 'bg-rose-50 text-rose-700 border-rose-200',
  ウイスキー: 'bg-amber-50 text-amber-700 border-amber-200',
  ジン: 'bg-teal-50 text-teal-700 border-teal-200',
  焼酎: 'bg-orange-50 text-orange-700 border-orange-200',
  ビール: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  ブランデー: 'bg-purple-50 text-purple-700 border-purple-200',
  シェリー: 'bg-red-50 text-red-700 border-red-200',
  ウォッカ: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  その他: 'bg-stone-50 text-stone-700 border-stone-200',
};

export const CategoryBadge: React.FC<CategoryBadgeProps> = ({ category, className = '' }) => {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${CATEGORY_COLOR_MAP[category]} ${className}`}
    >
      {category}
    </span>
  );
};

export interface GroupCountBadgeProps {
  count: number;
  className?: string;
}

export const GroupCountBadge: React.FC<GroupCountBadgeProps> = ({ count, className = '' }) => {
  if (count <= 1) return null;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-white shadow-sm ${className}`}
    >
      {count}本
    </span>
  );
};
