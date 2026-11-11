import React, { useState, useEffect, useMemo } from 'react';
import { BottleRecord, PhotoRecord } from '../types/sake';
import {
  GeminiBatchValidationResult,
  GeminiImportPayload,
} from '../domain/geminiPrompt';
import {
  findDuplicateBottles,
  detectIntraBatchDuplicates,
} from '../domain/bottleUtils';
import { cropPhotoRecordToNewPhotoRecord } from '../domain/photoUtils';
import { CATEGORY_ATTRIBUTE_LABELS } from '../domain/categories';
import { CloseIcon, BottlePlaceholderIcon, SparklesIcon } from './Icons';

export interface GeminiBatchImportModalProps {
  isOpen: boolean;
  batchResult: GeminiBatchValidationResult;
  draftPhotos: PhotoRecord[];
  primaryPhotoId: string | null;
  allBottles: BottleRecord[];
  onClose: () => void;
  onSubmitBatch: (
    selectedItems: GeminiImportPayload[],
    selectedPhotos: Array<PhotoRecord | null>
  ) => Promise<void>;
}

export const GeminiBatchImportModal: React.FC<GeminiBatchImportModalProps> = ({
  isOpen,
  batchResult,
  draftPhotos,
  primaryPhotoId,
  allBottles,
  onClose,
  onSubmitBatch,
}) => {
  // 1. デフォルト切り抜き元写真（代表写真、または1枚目のドラフト写真）
  const defaultSourcePhotoId = useMemo(() => {
    if (primaryPhotoId && draftPhotos.some((p) => p.id === primaryPhotoId)) {
      return primaryPhotoId;
    }
    return draftPhotos[0]?.id ?? null;
  }, [primaryPhotoId, draftPhotos]);

  const [selectedSourcePhotoId, setSelectedSourcePhotoId] = useState<string | null>(defaultSourcePhotoId);

  // 2. 切り抜き処理状態
  const [croppedPhotos, setCroppedPhotos] = useState<Record<number, PhotoRecord | null>>({});
  const [cropErrors, setCropErrors] = useState<Record<number, string>>({});
  const [isCropping, setIsCropping] = useState<boolean>(false);
  const [itemPhotoEnabled, setItemPhotoEnabled] = useState<Record<number, boolean>>({});

  // 3. アイテム選択状態（デフォルトは有効な要素すべて選択）
  const [selectedItemIndices, setSelectedItemIndices] = useState<Set<number>>(() => {
    const set = new Set<number>();
    batchResult.items.forEach((item, idx) => {
      if (item.success) {
        set.add(idx);
      }
    });
    return set;
  });

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 切り抜き元写真またはバッチ結果変更時に切り抜きを実行
  useEffect(() => {
    let isCancelled = false;
    const sourcePhoto = draftPhotos.find((p) => p.id === selectedSourcePhotoId);

    if (!sourcePhoto) {
      setCroppedPhotos({});
      setCropErrors({});
      setIsCropping(false);
      return;
    }

    async function runCrops() {
      if (!sourcePhoto) return;
      setIsCropping(true);
      const newCropped: Record<number, PhotoRecord | null> = {};
      const newErrors: Record<number, string> = {};
      const newPhotoEnabled: Record<number, boolean> = {};

      await Promise.all(
        batchResult.items.map(async (item, idx) => {
          if (!item.success || !item.data.cropBox) {
            newCropped[idx] = null;
            newPhotoEnabled[idx] = false;
            return;
          }

          try {
            const cropped = await cropPhotoRecordToNewPhotoRecord(
              sourcePhoto,
              item.data.cropBox,
              'temp-preview-id'
            );
            if (!isCancelled) {
              newCropped[idx] = cropped;
              newPhotoEnabled[idx] = true;
            }
          } catch (err) {
            if (!isCancelled) {
              newCropped[idx] = null;
              newPhotoEnabled[idx] = false;
              newErrors[idx] = err instanceof Error ? err.message : String(err);
            }
          }
        })
      );

      if (!isCancelled) {
        setCroppedPhotos(newCropped);
        setCropErrors(newErrors);
        setItemPhotoEnabled(newPhotoEnabled);
        setIsCropping(false);
      }
    }

    void runCrops();

    return () => {
      isCancelled = true;
    };
  }, [selectedSourcePhotoId, batchResult, draftPhotos]);

  // 有効なアイテム群
  const validItemsWithIndex = useMemo(() => {
    return batchResult.items
      .map((item, idx) => ({ item, idx }))
      .filter((entry): entry is { item: typeof entry.item & { success: true; data: GeminiImportPayload }; idx: number } => entry.item.success);
  }, [batchResult.items]);

  // セット内重複判定（有効アイテム間）
  const intraDuplicatesMap = useMemo(() => {
    const list = validItemsWithIndex.map(({ item }) => ({
      name: item.data.name,
      category: item.data.category,
    }));
    const dups = detectIntraBatchDuplicates(list);
    const map = new Map<number, (typeof dups)[0]>();
    validItemsWithIndex.forEach(({ idx }, listIdx) => {
      map.set(idx, dups[listIdx]!);
    });
    return map;
  }, [validItemsWithIndex]);

  // 全選択 / 全解除
  const handleSelectAll = () => {
    const set = new Set<number>();
    validItemsWithIndex.forEach(({ idx }) => set.add(idx));
    setSelectedItemIndices(set);
  };

  const handleDeselectAll = () => {
    setSelectedItemIndices(new Set());
  };

  const handleToggleItem = (idx: number) => {
    setSelectedItemIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const selectedCount = selectedItemIndices.size;

  // 確定送信
  const handleSubmit = async () => {
    if (selectedCount === 0 || isSubmitting || isCropping) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const selectedIndices = Array.from(selectedItemIndices).sort((a, b) => a - b);
      const selectedPayloads: GeminiImportPayload[] = [];
      const selectedPhotos: Array<PhotoRecord | null> = [];

      for (const idx of selectedIndices) {
        const item = batchResult.items[idx];
        if (item && item.success) {
          selectedPayloads.push(item.data);
          const usePhoto = itemPhotoEnabled[idx] ?? true;
          const photo = usePhoto ? croppedPhotos[idx] ?? null : null;
          selectedPhotos.push(photo);
        }
      }

      await onSubmitBatch(selectedPayloads, selectedPhotos);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 overflow-hidden sm:overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="複数銘柄の一括取り込み"
    >
      <div className="bg-white w-full max-w-2xl h-full h-dvh max-h-dvh sm:h-auto sm:max-h-[92vh] sm:rounded-3xl flex flex-col shadow-2xl overflow-hidden animate-in fade-in duration-200">
        {/* ヘッダー */}
        <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-amber-100 text-amber-900 rounded-lg">
              <SparklesIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-stone-900">
                複数銘柄の一括取り込み
              </h2>
              <p className="text-[11px] text-stone-500">
                Gemini が検出したお酒の一覧を確認して登録します（最大6本）
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            disabled={isSubmitting}
            className="min-h-touch min-w-touch p-2 -mr-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-full transition flex items-center justify-center"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        {/* スクロール可能コンテンツ部 */}
        <div className="p-4 sm:p-6 pb-6 space-y-4 overflow-y-auto flex-1">
          {/* 送信エラー表示 */}
          {submitError && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl font-medium">
              {submitError}
            </div>
          )}

          {/* 添付写真複数時の切り抜き元選択バー */}
          {draftPhotos.length >= 2 && (
            <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-stone-800">
                  切り抜き元の集合写真を選択:
                </span>
                <span className="text-[11px] text-stone-500">
                  タップで全ボトルの切り抜き位置を再計算
                </span>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {draftPhotos.map((photo, pIdx) => {
                  const isSelected = photo.id === selectedSourcePhotoId;
                  return (
                    <button
                      key={photo.id}
                      type="button"
                      onClick={() => setSelectedSourcePhotoId(photo.id)}
                      className={`relative rounded-xl overflow-hidden border-2 transition shrink-0 ${
                        isSelected
                          ? 'border-amber-600 ring-2 ring-amber-400'
                          : 'border-stone-200 opacity-60 hover:opacity-100'
                      }`}
                    >
                      <img
                        src={photo.dataUrl}
                        alt={`添付写真 ${pIdx + 1}`}
                        className="w-16 h-16 object-cover"
                      />
                      {isSelected && (
                        <div className="absolute bottom-0 inset-x-0 bg-amber-600 text-white text-[10px] text-center font-bold py-0.5">
                          切り抜き元
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {draftPhotos.length === 0 && (
            <div className="p-3 bg-stone-100 rounded-xl text-stone-600 text-xs">
              ※写真が添付されていないため、すべてのボトルは「写真なし」で登録されます。
            </div>
          )}

          {/* 一括操作バー */}
          <div className="flex items-center justify-between px-1 text-xs">
            <div className="text-stone-600">
              全 <strong className="text-stone-900">{batchResult.totalCount}</strong> 件中{' '}
              <strong className="text-emerald-700">{batchResult.validCount}</strong> 件が登録可能
              （選択中: <strong className="text-stone-900">{selectedCount}</strong> 本）
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-stone-700 hover:text-stone-900 underline text-xs font-medium"
              >
                すべて選択
              </button>
              <span className="text-stone-300">|</span>
              <button
                type="button"
                onClick={handleDeselectAll}
                className="text-stone-700 hover:text-stone-900 underline text-xs font-medium"
              >
                すべて解除
              </button>
            </div>
          </div>

          {/* 切り抜き処理中の案内 */}
          {isCropping && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center gap-2 animate-pulse font-medium">
              <SparklesIcon className="w-4 h-4 text-amber-600 animate-spin" />
              <span>集合写真から各ボトルの写真を切り抜き中...</span>
            </div>
          )}

          {/* 各ボトルのプレビューカード一覧 */}
          <div className="space-y-3">
            {batchResult.items.map((item, idx) => {
              if (!item.success) {
                // 無効な要素（赤枠エラー表示・選択不可）
                return (
                  <div
                    key={`invalid-${idx}`}
                    className="p-4 rounded-2xl border-2 border-rose-300 bg-rose-50/60 space-y-2"
                  >
                    <div className="flex items-center gap-2 text-rose-800 font-bold text-xs">
                      <span className="px-2 py-0.5 bg-rose-200 text-rose-900 rounded-md">
                        登録不可
                      </span>
                      <span>{item.index + 1}本目</span>
                    </div>
                    <div className="text-xs text-rose-800 space-y-1">
                      <div className="font-semibold">取り込みエラー理由:</div>
                      <ul className="list-disc list-inside space-y-0.5 text-rose-700">
                        {item.errors.map((err, errIdx) => (
                          <li key={errIdx}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                );
              }

              const isSelected = selectedItemIndices.has(idx);
              const croppedPhoto = croppedPhotos[idx];
              const cropErr = cropErrors[idx];
              const isPhotoChecked = itemPhotoEnabled[idx] ?? true;

              // 重複判定
              const dupInfo = findDuplicateBottles(allBottles, item.data);
              const totalDupCount =
                dupInfo.breakdown.inventory + dupInfo.breakdown.finished + dupInfo.breakdown.disposed;
              const intraDup = intraDuplicatesMap.get(idx);

              // 種類別属性ラベル
              const categoryAttrLabels = CATEGORY_ATTRIBUTE_LABELS[item.data.category] || {};
              const attrEntries = Object.entries(item.data.categoryAttributes).filter(
                ([, val]) => val !== null && val !== undefined && val !== ''
              );

              return (
                <div
                  key={`valid-${idx}`}
                  className={`p-4 rounded-2xl border transition space-y-3.5 ${
                    isSelected
                      ? 'border-stone-900 bg-white shadow-sm ring-1 ring-stone-900/10'
                      : 'border-stone-200 bg-stone-50/70 opacity-75'
                  }`}
                >
                  {/* カードヘッダー: チェックボックス + 銘柄名 + 種類 */}
                  <div className="flex items-start justify-between gap-3">
                    <label className="flex items-start gap-3 cursor-pointer select-none flex-1">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleItem(idx)}
                        className="mt-1 w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900 cursor-pointer shrink-0"
                      />
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[11px] font-bold px-1.5 py-0.5 bg-stone-100 text-stone-700 rounded">
                            {item.index + 1}本目
                          </span>
                          <span className="px-2 py-0.5 bg-stone-800 text-white rounded text-[11px] font-bold">
                            {item.data.category}
                          </span>
                          <h3 className="text-sm font-bold text-stone-900">
                            {item.data.name}
                          </h3>
                        </div>
                        {/* スペック要約 */}
                        <div className="flex items-center gap-3 text-xs text-stone-600 flex-wrap">
                          {item.data.abv !== null && (
                            <span>度数: <strong>{item.data.abv}%</strong></span>
                          )}
                          {item.data.volumeMl !== null && (
                            <span>容量: <strong>{item.data.volumeMl}ml</strong></span>
                          )}
                          {attrEntries.map(([key, val]) => {
                            const label = categoryAttrLabels[key] || key;
                            return (
                              <span key={key}>
                                {label}: <strong>{String(val)}</strong>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* 写真プレビュー & 切り抜き採用トグル */}
                  <div className="flex items-center gap-3 p-2.5 bg-stone-50 rounded-xl border border-stone-200/80">
                    <div className="w-16 h-16 rounded-lg overflow-hidden bg-stone-200 flex items-center justify-center shrink-0 border border-stone-300">
                      {croppedPhoto && isPhotoChecked ? (
                        <img
                          src={croppedPhoto.dataUrl}
                          alt={item.data.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <BottlePlaceholderIcon className="w-8 h-8 text-stone-400" />
                      )}
                    </div>
                    <div className="space-y-1 text-xs flex-1">
                      {croppedPhoto ? (
                        <label className="flex items-center gap-2 cursor-pointer font-medium text-stone-800">
                          <input
                            type="checkbox"
                            checked={isPhotoChecked}
                            onChange={(e) =>
                              setItemPhotoEnabled((prev) => ({
                                ...prev,
                                [idx]: e.target.checked,
                              }))
                            }
                            className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900 cursor-pointer"
                          />
                          <span>この切り抜き写真を使う</span>
                        </label>
                      ) : (
                        <span className="text-stone-500 font-medium">
                          写真なし（{draftPhotos.length === 0 ? '添付写真なし' : '切り抜き範囲なし'}）
                        </span>
                      )}
                      <p className="text-[11px] text-stone-500">
                        {croppedPhoto && isPhotoChecked
                          ? '集合写真から切り抜いた画像がこのボトルの写真として保存されます。'
                          : '写真なしで登録します（後から個別に撮影・追加できます）。'}
                      </p>
                    </div>
                  </div>

                  {/* 相場目安表示 */}
                  {item.data.referencePrice?.estimatedPriceYen !== null &&
                    item.data.referencePrice?.estimatedPriceYen !== undefined && (
                      <div className="text-xs text-stone-700 bg-stone-100/80 px-2.5 py-1.5 rounded-lg flex items-center gap-2">
                        <span className="font-bold">相場目安:</span>
                        <span>
                          ¥{item.data.referencePrice.estimatedPriceYen.toLocaleString()}
                        </span>
                        {item.data.referencePrice.fetchedDate && (
                          <span className="text-[11px] text-stone-500">
                            （取得日: {item.data.referencePrice.fetchedDate}）
                          </span>
                        )}
                        {item.data.referencePrice.note && (
                          <span className="text-[11px] text-stone-500">
                            ※{item.data.referencePrice.note}
                          </span>
                        )}
                      </div>
                    )}

                  {/* 解説のサマリー */}
                  {item.data.description && (
                    <div className="text-xs text-stone-600 bg-stone-50 p-2.5 rounded-xl border border-stone-200/60 space-y-1">
                      {item.data.description.summary && (
                        <p className="line-clamp-2">
                          <span className="font-bold text-stone-800">概要: </span>
                          {item.data.description.summary}
                        </p>
                      )}
                      {item.data.description.tasteProfile && (
                        <p className="line-clamp-1 text-[11px] text-stone-500">
                          <span className="font-bold text-stone-700">味わい: </span>
                          {item.data.description.tasteProfile}
                        </p>
                      )}
                    </div>
                  )}

                  {/* 警告表示 */}
                  {/* 1. 既存コレクション重複 */}
                  {dupInfo.hasDuplicate && (
                    <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-950 rounded-xl text-xs space-y-1">
                      <div className="font-bold">
                        ⚠️ 既存データ重複: 『{item.data.name}』は既に {totalDupCount}本 登録されています
                      </div>
                      <div className="text-[11px] text-amber-800">
                        家にある酒: <strong>{dupInfo.breakdown.inventory}本</strong> /
                        飲んだ記録: <strong>{dupInfo.breakdown.finished}本</strong> /
                        手放した酒: <strong>{dupInfo.breakdown.disposed}本</strong>
                      </div>
                    </div>
                  )}

                  {/* 2. セット内重複 */}
                  {intraDup && intraDup.hasDuplicate && (
                    <div className="p-2 bg-blue-50 border border-blue-200 text-blue-900 rounded-xl text-xs flex items-center gap-1.5 font-medium">
                      <span>
                        ℹ️ セット内重複: この取り込みデータ内に同名銘柄が {intraDup.duplicateCount} 件含まれています（それぞれ独立したボトルとして登録されます）
                      </span>
                    </div>
                  )}

                  {/* 3. 個別要素警告 */}
                  {item.warnings.length > 0 && (
                    <div className="p-2 bg-amber-50/70 border border-amber-200/80 rounded-xl text-xs text-amber-900 space-y-0.5">
                      <span className="font-bold text-[11px] block">取り込み警告:</span>
                      <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-800">
                        {item.warnings.map((w, wIdx) => (
                          <li key={wIdx}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 4. 切り抜きエラー警告 */}
                  {cropErr && (
                    <div className="p-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl">
                      切り抜き処理に失敗したため写真なしで取り込みます: {cropErr}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 固定フッター */}
        <div className="sticky bottom-0 z-20 bg-white/95 backdrop-blur border-t border-stone-200 px-4 py-3 shrink-0 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="w-1/3 min-h-touch bg-stone-200 hover:bg-stone-300 text-stone-800 font-semibold text-xs sm:text-sm rounded-xl transition"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={selectedCount === 0 || isSubmitting || isCropping}
            onClick={handleSubmit}
            className="w-2/3 min-h-touch bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 text-white font-bold text-xs sm:text-sm rounded-xl transition shadow-sm flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <span>登録中...</span>
            ) : isCropping ? (
              <span>切り抜き中...</span>
            ) : (
              <span>選択した {selectedCount} 本を一括登録する</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
