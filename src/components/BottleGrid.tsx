import React from 'react';
import { BottleGroup } from '../domain/sortAndGroup';
import { PhotoRecord } from '../types/sake';
import { BottleCard } from './BottleCard';

export interface BottleGridProps {
  groups: BottleGroup[];
  photos: PhotoRecord[];
  onSelectGroup: (group: BottleGroup) => void;
  emptyMessage?: string;
}

export const BottleGrid: React.FC<BottleGridProps> = ({
  groups,
  photos,
  onSelectGroup,
  emptyMessage = '該当するお酒がありません',
}) => {
  const photoMap = new Map(photos.map((p) => [p.id, p]));

  if (groups.length === 0) {
    return (
      <div className="py-16 text-center text-stone-500">
        <p className="text-sm font-medium">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      {groups.map((group) => {
        const photo = group.primaryPhotoId ? photoMap.get(group.primaryPhotoId) : undefined;
        return (
          <BottleCard
            key={group.groupKey}
            group={group}
            photo={photo}
            onClick={onSelectGroup}
          />
        );
      })}
    </div>
  );
};
