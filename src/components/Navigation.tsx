import React from 'react';
import { HomeIcon, HistoryIcon, DisposedIcon, SettingsIcon } from './Icons';

export type TabKey = 'inventory' | 'finished' | 'disposed' | 'settings';

export interface NavigationProps {
  activeTab: TabKey;
  onSelectTab: (tab: TabKey) => void;
  inventoryCount?: number;
  finishedCount?: number;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onSelectTab,
  inventoryCount = 0,
  finishedCount = 0,
}) => {
  const tabs: Array<{
    key: TabKey;
    label: string;
    icon: React.ReactNode;
    badgeCount?: number;
  }> = [
    {
      key: 'inventory',
      label: '家にある酒',
      icon: <HomeIcon className="w-5 h-5" />,
      badgeCount: inventoryCount > 0 ? inventoryCount : undefined,
    },
    {
      key: 'finished',
      label: '飲んだ記録',
      icon: <HistoryIcon className="w-5 h-5" />,
      badgeCount: finishedCount > 0 ? finishedCount : undefined,
    },
    {
      key: 'disposed',
      label: '手放した酒',
      icon: <DisposedIcon className="w-5 h-5" />,
    },
    {
      key: 'settings',
      label: 'データ管理',
      icon: <SettingsIcon className="w-5 h-5" />,
    },
  ];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-stone-200"
      aria-label="主要ナビゲーション"
    >
      <div className="max-w-md mx-auto grid grid-cols-4 px-1 py-1">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onSelectTab(tab.key)}
              className={`min-h-touch min-w-touch flex flex-col items-center justify-center py-1.5 px-1 rounded-lg transition relative ${
                isActive
                  ? 'text-stone-900 font-bold'
                  : 'text-stone-500 hover:text-stone-700 font-medium'
              }`}
            >
              <div className="relative">
                {tab.icon}
                {tab.badgeCount !== undefined && (
                  <span className="absolute -top-1.5 -right-2.5 px-1.5 py-0.2 text-[10px] font-bold leading-none bg-stone-900 text-white rounded-full">
                    {tab.badgeCount}
                  </span>
                )}
              </div>
              <span className="text-[11px] mt-1 tracking-tight truncate max-w-full">
                {tab.label}
              </span>
              {isActive && (
                <span className="absolute bottom-1 w-6 h-0.5 bg-stone-900 rounded-full" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
