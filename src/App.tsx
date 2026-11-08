import React from 'react';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from './data/sampleData';

export const App: React.FC = () => {
  return (
    <div className="min-h-screen p-4 max-w-md mx-auto">
      <header className="py-4 border-b border-stone-200">
        <h1 className="text-xl font-bold text-stone-900">sake-collection</h1>
        <p className="text-sm text-stone-500 mt-1">手持ちのお酒を把握するローカルコレクション</p>
      </header>

      <main className="py-6 space-y-4">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-stone-200">
          <h2 className="font-semibold text-stone-800 mb-2">PR #1 検証環境</h2>
          <p className="text-sm text-stone-600 mb-4">
            雛形・データモデル・サンプルデータ・標準検証基盤が正常に構築されています。
          </p>
          <div className="grid grid-cols-2 gap-2 text-center text-sm">
            <div className="bg-stone-50 p-3 rounded-lg border border-stone-200">
              <span className="block text-xs text-stone-500">サンプルボトル</span>
              <span className="text-lg font-bold text-stone-800">{SAMPLE_BOTTLES.length}本</span>
            </div>
            <div className="bg-stone-50 p-3 rounded-lg border border-stone-200">
              <span className="block text-xs text-stone-500">サンプル写真</span>
              <span className="text-lg font-bold text-stone-800">{SAMPLE_PHOTOS.length}枚</span>
            </div>
          </div>
        </div>

        <div className="pt-2">
          <button
            type="button"
            className="w-full min-h-touch bg-stone-900 text-white rounded-lg font-medium text-sm hover:bg-stone-800 active:scale-95 transition"
            onClick={() => {
              window.alert(`サンプルデータ ${SAMPLE_BOTTLES.length} 本を確認しました。`);
            }}
          >
            サンプルデータ確認
          </button>
        </div>
      </main>
    </div>
  );
};

export default App;
