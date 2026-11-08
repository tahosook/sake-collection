import React, { useState } from 'react';
import { useCollection } from './storage/useCollection';
import { BottleRecord, SakeCategory, BottleStatus } from './types/sake';
import { BottleGroup, groupBottlesForDisplay } from './domain/sortAndGroup';
import { filterBottles } from './domain/searchAndFilter';
import { Navigation, TabKey } from './components/Navigation';
import { SearchBar } from './components/SearchBar';
import { BottleGrid } from './components/BottleGrid';
import { BottleHistoryList } from './components/BottleHistoryList';
import { GroupDetailSheet } from './components/GroupDetailSheet';
import { BottleDetailModal } from './components/BottleDetailModal';
import { BottleFormModal } from './components/BottleFormModal';
import { DataManagementView } from './components/DataManagementView';
import { PlusIcon } from './components/Icons';

export const App: React.FC = () => {
  const {
    bottles,
    allBottles,
    photos,
    isLoading,
    error,
    addBottle,
    updateBottle,
    changeBottleStatus,
    deleteBottle,
    exportBackup,
    importBackup,
    resetWithSampleData,
    clearAll,
  } = useCollection();

  // ナビゲーションタブ
  const [activeTab, setActiveTab] = useState<TabKey>('inventory');

  // 検索・絞り込み状態
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<SakeCategory | 'all'>('all');
  const [inventoryStatusFilter, setInventoryStatusFilter] = useState<BottleStatus | 'all'>('all');

  // モーダル・シート状態
  const [selectedGroupForSheet, setSelectedGroupForSheet] = useState<BottleGroup | null>(null);
  const [selectedBottleForDetail, setSelectedBottleForDetail] = useState<BottleRecord | null>(null);
  const [isFormModalOpen, setIsFormModalOpen] = useState<boolean>(false);
  const [editingBottle, setEditingBottle] = useState<BottleRecord | null>(null);

  // 1. 各状態ごとのボトル分類（deleted は既に除外済み）
  const inventoryBottles = bottles.filter(
    (b) => b.status === 'unopened' || b.status === 'opened'
  );
  const finishedBottles = bottles.filter((b) => b.status === 'finished');
  const disposedBottles = bottles.filter((b) => b.status === 'disposed');

  // 2. 検索・絞り込みの適用
  // (a) いま家にある酒
  const filteredInventoryBottles = filterBottles(inventoryBottles, {
    query: searchQuery,
    category: selectedCategory,
    status: inventoryStatusFilter,
  });
  const inventoryGroups = groupBottlesForDisplay(filteredInventoryBottles);

  // (b) 飲んだ記録
  const filteredFinishedBottles = filterBottles(finishedBottles, {
    query: searchQuery,
    category: selectedCategory,
  });

  // (c) 手放した酒
  const filteredDisposedBottles = filterBottles(disposedBottles, {
    query: searchQuery,
    category: selectedCategory,
  });

  // グループタップ時のハンドラー（1本なら直接詳細へ、2本以上ならシートを開く）
  const handleSelectGroup = (group: BottleGroup) => {
    if (group.bottles.length === 1 && group.bottles[0]) {
      setSelectedBottleForDetail(group.bottles[0]);
    } else {
      setSelectedGroupForSheet(group);
    }
  };

  // 詳細モーダルから「また買いたい」のトグル
  const handleToggleWantToBuyAgain = async (bottle: BottleRecord) => {
    const updated: BottleRecord = {
      ...bottle,
      wantToBuyAgain: !bottle.wantToBuyAgain,
      updatedAt: new Date().toISOString(),
    };
    await updateBottle(updated);
    setSelectedBottleForDetail(updated);
  };

  // 状態変更ハンドラー
  const handleChangeStatus = async (
    bottleId: string,
    newStatus: BottleStatus,
    dateOverride?: string | null
  ) => {
    const res = await changeBottleStatus(bottleId, newStatus, dateOverride);
    if (res) {
      setSelectedBottleForDetail(res);
      // シート表示中の場合は閉じる
      if (selectedGroupForSheet) {
        setSelectedGroupForSheet(null);
      }
    }
    return res;
  };

  // 編集モーダルを開く
  const handleOpenEdit = (bottle: BottleRecord) => {
    setEditingBottle(bottle);
    setIsFormModalOpen(true);
  };

  // 新規登録モーダルを開く
  const handleOpenCreate = () => {
    setEditingBottle(null);
    setIsFormModalOpen(true);
  };

  // フォーム送信ハンドラー（新規または更新）
  const handleFormSubmit = async (data: Parameters<typeof addBottle>[0] | BottleRecord) => {
    if ('id' in data) {
      await updateBottle(data);
      if (selectedBottleForDetail?.id === data.id) {
        setSelectedBottleForDetail(data);
      }
    } else {
      const created = await addBottle(data);
      setSelectedBottleForDetail(created);
    }
  };

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 pb-24 select-none sm:select-auto">
      {/* グローバルヘッダー */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-base font-black text-stone-900 tracking-tight">
              sake-collection
            </h1>
            <p className="text-[11px] text-stone-500 font-medium">
              {activeTab === 'inventory' && 'いま家にある酒'}
              {activeTab === 'finished' && '飲んだ記録（時系列）'}
              {activeTab === 'disposed' && '手放した酒'}
              {activeTab === 'settings' && 'データ管理・設定'}
            </p>
          </div>

          {/* 新規登録ボタン */}
          <button
            type="button"
            onClick={handleOpenCreate}
            className="min-h-touch px-3 py-1.5 bg-stone-900 hover:bg-stone-800 active:scale-95 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5 shadow-sm"
          >
            <PlusIcon className="w-4 h-4" />
            <span>登録</span>
          </button>
        </div>
      </header>

      {/* メインエリア */}
      <main className="max-w-md mx-auto p-4 space-y-4">
        {/* エラー表示 */}
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl font-medium">
            エラー: {error}
          </div>
        )}

        {/* データゼロ時の初期案内バナー（未読込・空端末対応） */}
        {!isLoading && allBottles.length === 0 && (
          <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm text-center space-y-3">
            <h2 className="text-base font-bold text-stone-900">
              お酒のデータがありません
            </h2>
            <p className="text-xs text-stone-600 leading-relaxed">
              受入確認用のサンプルデータを読み込むか、上の「＋ 登録」からお持ちのお酒を手入力で登録してください。
            </p>
            <div className="pt-2 flex flex-col gap-2">
              <button
                type="button"
                onClick={resetWithSampleData}
                className="w-full min-h-touch bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold text-xs py-2.5 rounded-xl transition"
              >
                サンプルデータを読み込む（14本・写真4枚）
              </button>
              <button
                type="button"
                onClick={handleOpenCreate}
                className="w-full min-h-touch bg-stone-900 hover:bg-stone-800 text-white font-bold text-xs py-2.5 rounded-xl transition"
              >
                最初のお酒を手入力登録する
              </button>
            </div>
          </div>
        )}

        {/* 検索・絞り込みバー（設定タブ以外で表示） */}
        {activeTab !== 'settings' && allBottles.length > 0 && (
          <SearchBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
            selectedStatus={inventoryStatusFilter}
            onStatusChange={setInventoryStatusFilter}
            showStatusFilter={activeTab === 'inventory'}
          />
        )}

        {/* タブコンテンツ */}
        {isLoading ? (
          <div className="py-20 text-center text-stone-400 text-sm">
            読み込み中...
          </div>
        ) : (
          <>
            {/* 1. 家にある酒（一覧：写真グリッド・まとめ表示） */}
            {activeTab === 'inventory' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-stone-500 px-1">
                  <span>表示中: {filteredInventoryBottles.length}本（{inventoryGroups.length}銘柄）</span>
                  {inventoryBottles.length !== filteredInventoryBottles.length && (
                    <span className="text-amber-700 font-medium">絞り込み中</span>
                  )}
                </div>
                <BottleGrid
                  groups={inventoryGroups}
                  photos={photos}
                  onSelectGroup={handleSelectGroup}
                  emptyMessage={
                    searchQuery || selectedCategory !== 'all' || inventoryStatusFilter !== 'all'
                      ? '条件に一致するお酒がありません'
                      : '現在家にあるお酒はありません'
                  }
                />
              </div>
            )}

            {/* 2. 飲んだ記録（時系列一覧） */}
            {activeTab === 'finished' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-stone-500 px-1">
                  <span>飲み切り記録: {filteredFinishedBottles.length}本</span>
                </div>
                <BottleHistoryList
                  bottles={filteredFinishedBottles}
                  photos={photos}
                  onSelectBottle={setSelectedBottleForDetail}
                  emptyMessage="飲み切ったお酒の記録はありません"
                  type="finished"
                />
              </div>
            )}

            {/* 3. 手放した酒一覧 */}
            {activeTab === 'disposed' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-stone-500 px-1">
                  <span>手放したお酒: {filteredDisposedBottles.length}本</span>
                </div>
                <BottleHistoryList
                  bottles={filteredDisposedBottles}
                  photos={photos}
                  onSelectBottle={setSelectedBottleForDetail}
                  emptyMessage="手放したお酒の記録はありません"
                  type="disposed"
                />
              </div>
            )}

            {/* 4. データ管理・設定 */}
            {activeTab === 'settings' && (
              <DataManagementView
                bottles={bottles}
                allBottles={allBottles}
                photos={photos}
                onExportBackup={exportBackup}
                onImportBackup={importBackup}
                onResetSampleData={resetWithSampleData}
                onClearAll={clearAll}
              />
            )}
          </>
        )}
      </main>

      {/* 同一銘柄展開モーダルシート */}
      {selectedGroupForSheet && (
        <GroupDetailSheet
          key={selectedGroupForSheet.groupKey}
          group={selectedGroupForSheet}
          onClose={() => setSelectedGroupForSheet(null)}
          onSelectBottle={(bottle) => {
            setSelectedBottleForDetail(bottle);
          }}
        />
      )}

      {/* ボトル詳細モーダル */}
      {selectedBottleForDetail && (
        <BottleDetailModal
          key={selectedBottleForDetail.id}
          bottle={selectedBottleForDetail}
          photos={photos}
          onClose={() => setSelectedBottleForDetail(null)}
          onEdit={handleOpenEdit}
          onDelete={async (id) => {
            await deleteBottle(id);
            setSelectedBottleForDetail(null);
          }}
          onChangeStatus={handleChangeStatus}
          onToggleWantToBuyAgain={handleToggleWantToBuyAgain}
        />
      )}

      {/* ボトル登録・編集モーダル */}
      {isFormModalOpen && (
        <BottleFormModal
          key={editingBottle ? `edit-${editingBottle.id}` : 'create'}
          initialBottle={editingBottle}
          isOpen={isFormModalOpen}
          onClose={() => {
            setIsFormModalOpen(false);
            setEditingBottle(null);
          }}
          onSubmit={handleFormSubmit}
        />
      )}

      {/* 主要ボトムナビゲーション */}
      <Navigation
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        inventoryCount={inventoryBottles.length}
        finishedCount={finishedBottles.length}
      />
    </div>
  );
};

export default App;
