import React, { useState } from 'react';
import {
  BottleRecord,
  SakeCategory,
  SAKE_CATEGORIES,
  BottleStatus,
  BOTTLE_STATUSES,
  CategoryAttributes,
} from '../types/sake';
import { CreateBottleInput } from '../domain/bottleUtils';
import { CATEGORY_ATTRIBUTE_LABELS } from '../domain/categories';
import { isValidCalendarDate } from '../domain/validation';
import { STATUS_LABELS } from '../domain/status';
import { CloseIcon } from './Icons';

export interface BottleFormModalProps {
  initialBottle?: BottleRecord | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CreateBottleInput | BottleRecord) => Promise<void>;
}

export const BottleFormModal: React.FC<BottleFormModalProps> = ({
  initialBottle,
  isOpen,
  onClose,
  onSubmit,
}) => {
  const isEditing = Boolean(initialBottle);

  // フォーム状態の初期化
  const [name, setName] = useState<string>(initialBottle?.name ?? '');
  const [category, setCategory] = useState<SakeCategory>(initialBottle?.category ?? '日本酒');
  const [status, setStatus] = useState<BottleStatus>(initialBottle?.status ?? 'unopened');
  const [volumeMl, setVolumeMl] = useState<string>(
    initialBottle?.volumeMl !== null && initialBottle?.volumeMl !== undefined
      ? String(initialBottle.volumeMl)
      : ''
  );
  const [abv, setAbv] = useState<string>(
    initialBottle?.abv !== null && initialBottle?.abv !== undefined
      ? String(initialBottle.abv)
      : ''
  );

  // 日付フィールド（状態によって表示・保存条件が変化）
  const [openedDate, setOpenedDate] = useState<string>(initialBottle?.openedDate ?? '');
  const [finishedDate, setFinishedDate] = useState<string>(initialBottle?.finishedDate ?? '');
  const [disposedDate, setDisposedDate] = useState<string>(initialBottle?.disposedDate ?? '');

  // 種類別属性
  const [attributes, setAttributes] = useState<Record<string, string | number>>(
    (initialBottle?.categoryAttributes as Record<string, string | number>) ?? {}
  );

  // 購入情報
  const [purchaseDate, setPurchaseDate] = useState<string>(
    initialBottle?.purchaseInfo.purchaseDate ?? ''
  );
  const [purchasePlace, setPurchasePlace] = useState<string>(
    initialBottle?.purchaseInfo.purchasePlace ?? ''
  );
  const [purchasePriceYen, setPurchasePriceYen] = useState<string>(
    initialBottle?.purchaseInfo.purchasePriceYen !== null &&
      initialBottle?.purchaseInfo.purchasePriceYen !== undefined
      ? String(initialBottle.purchaseInfo.purchasePriceYen)
      : ''
  );

  // メモとまた買いたい
  const [tastingNote, setTastingNote] = useState<string>(initialBottle?.tastingNote ?? '');
  const [wantToBuyAgain, setWantToBuyAgain] = useState<boolean>(
    initialBottle?.wantToBuyAgain ?? false
  );

  // バリデーションエラー
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  if (!isOpen) return null;

  // 種類が変更された際の属性リセット/初期化
  const handleCategoryChange = (newCat: SakeCategory) => {
    setCategory(newCat);
    setAttributes({});
  };

  const currentAttributeLabels = CATEGORY_ATTRIBUTE_LABELS[category] ?? {};

  // 保存実行
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    // 1. 名前チェック
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage('お酒の名前（銘柄名）を入力してください');
      return;
    }

    // 2. 日付の妥当性チェック
    const validateDate = (d: string, label: string): string | null => {
      const trimmed = d.trim();
      if (!trimmed) return null;
      if (!isValidCalendarDate(trimmed)) {
        return `${label}に実在する有効な日付（YYYY-MM-DD）を入力してください`;
      }
      return null;
    };

    if (purchaseDate) {
      const err = validateDate(purchaseDate, '購入日');
      if (err) {
        setErrorMessage(err);
        return;
      }
    }
    if (status !== 'unopened') {
      if (openedDate) {
        const err = validateDate(openedDate, '開封日');
        if (err) {
          setErrorMessage(err);
          return;
        }
      }
      if (status === 'finished' && finishedDate) {
        const err = validateDate(finishedDate, '飲み切り日');
        if (err) {
          setErrorMessage(err);
          return;
        }
      }
      if (status === 'disposed' && disposedDate) {
        const err = validateDate(disposedDate, '手放した日');
        if (err) {
          setErrorMessage(err);
          return;
        }
      }
    }

    // 3. 数値の変換
    const numVolume = volumeMl.trim() ? Number(volumeMl) : null;
    if (numVolume !== null && (isNaN(numVolume) || numVolume <= 0)) {
      setErrorMessage('容量は正の数値を入力してください');
      return;
    }

    const numAbv = abv.trim() ? Number(abv) : null;
    if (numAbv !== null && (isNaN(numAbv) || numAbv < 0 || numAbv > 100)) {
      setErrorMessage('度数は0から100の間の数値を入力してください');
      return;
    }

    const numPrice = purchasePriceYen.trim() ? Number(purchasePriceYen) : null;
    if (numPrice !== null && (isNaN(numPrice) || numPrice < 0)) {
      setErrorMessage('購入価格は0以上の数値を入力してください');
      return;
    }

    // 4. 状態に応じた日付の正規化
    let finalOpenedDate: string | null = null;
    let finalFinishedDate: string | null = null;
    let finalDisposedDate: string | null = null;

    if (status === 'opened') {
      finalOpenedDate = openedDate.trim() || null;
    } else if (status === 'finished') {
      finalOpenedDate = openedDate.trim() || null;
      finalFinishedDate = finishedDate.trim() || null;
    } else if (status === 'disposed') {
      finalOpenedDate = openedDate.trim() || null;
      finalDisposedDate = disposedDate.trim() || null;
    }

    // 5. 属性の整理
    const cleanAttributes: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(attributes)) {
      if (val !== undefined && val !== null && val !== '') {
        if (key === 'vintageYear') {
          cleanAttributes[key] = typeof val === 'number' ? val : Number(val);
        } else {
          cleanAttributes[key] = val;
        }
      }
    }

    setIsSubmitting(true);
    try {
      if (isEditing && initialBottle) {
        // 既存編集
        const updatedBottle: BottleRecord = {
          ...initialBottle,
          name: trimmedName,
          category,
          status,
          volumeMl: numVolume,
          abv: numAbv,
          openedDate: finalOpenedDate,
          finishedDate: finalFinishedDate,
          disposedDate: finalDisposedDate,
          categoryAttributes: cleanAttributes as CategoryAttributes,
          purchaseInfo: {
            purchaseDate: purchaseDate.trim() || null,
            purchasePlace: purchasePlace.trim(),
            purchasePriceYen: numPrice,
          },
          tastingNote: tastingNote.trim(),
          wantToBuyAgain,
          updatedAt: new Date().toISOString(),
        } as BottleRecord;
        await onSubmit(updatedBottle);
      } else {
        // 新規登録
        const createInput = {
          name: trimmedName,
          category,
          status,
          volumeMl: numVolume,
          abv: numAbv,
          openedDate: finalOpenedDate,
          finishedDate: finalFinishedDate,
          disposedDate: finalDisposedDate,
          categoryAttributes: cleanAttributes as CategoryAttributes,
          purchaseInfo: {
            purchaseDate: purchaseDate.trim() || null,
            purchasePlace: purchasePlace.trim(),
            purchasePriceYen: numPrice,
          },
          tastingNote: tastingNote.trim(),
          wantToBuyAgain,
        } as CreateBottleInput;
        await onSubmit(createInput);
      }
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={isEditing ? 'お酒の編集' : 'お酒を手入力登録'}
    >
      <div className="bg-white w-full max-w-lg min-h-screen sm:min-h-0 sm:max-h-[92vh] sm:rounded-3xl flex flex-col shadow-2xl overflow-hidden animate-in fade-in duration-200">
        {/* ヘッダー */}
        <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3.5 flex items-center justify-between">
          <h2 className="text-base sm:text-lg font-bold text-stone-900">
            {isEditing ? 'お酒を編集' : 'お酒を手入力登録'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="min-h-touch min-w-touch p-2 -mr-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-full transition flex items-center justify-center"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        {/* フォーム入力部 */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-5 overflow-y-auto flex-1">
          {/* エラー表示 */}
          {errorMessage && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl font-medium">
              {errorMessage}
            </div>
          )}

          {/* 1. 基本情報 */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-stone-700 mb-1">
                名前・銘柄名 <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: 獺祭 純米大吟醸45"
                required
                className="w-full min-h-touch px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-sm outline-none transition"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  種類 <span className="text-rose-500">*</span>
                </label>
                <select
                  value={category}
                  onChange={(e) => handleCategoryChange(e.target.value as SakeCategory)}
                  className="w-full min-h-touch px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-sm outline-none transition"
                >
                  {SAKE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  状態 <span className="text-rose-500">*</span>
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as BottleStatus)}
                  className="w-full min-h-touch px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-sm outline-none transition"
                >
                  {BOTTLE_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {STATUS_LABELS[st]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">
                  容量（ml）
                </label>
                <input
                  type="number"
                  value={volumeMl}
                  onChange={(e) => setVolumeMl(e.target.value)}
                  placeholder="例: 720"
                  min="1"
                  className="w-full min-h-touch px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-sm outline-none transition"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">
                  度数（%）
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={abv}
                  onChange={(e) => setAbv(e.target.value)}
                  placeholder="例: 15.5"
                  min="0"
                  max="100"
                  className="w-full min-h-touch px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-sm outline-none transition"
                />
              </div>
            </div>
          </div>

          {/* 2. 状態連動の日付欄（未開封時は非表示、開封時・飲み切り時・手放した時のみ表示） */}
          {status !== 'unopened' && (
            <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200 space-y-3">
              <h3 className="text-xs font-bold text-stone-700">状態に関する日付</h3>

              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">
                  開封日（任意）
                </label>
                <input
                  type="date"
                  value={openedDate}
                  onChange={(e) => setOpenedDate(e.target.value)}
                  className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm"
                />
              </div>

              {status === 'finished' && (
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">
                    飲み切り日（任意）
                  </label>
                  <input
                    type="date"
                    value={finishedDate}
                    onChange={(e) => setFinishedDate(e.target.value)}
                    className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm"
                  />
                </div>
              )}

              {status === 'disposed' && (
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">
                    手放した日（任意）
                  </label>
                  <input
                    type="date"
                    value={disposedDate}
                    onChange={(e) => setDisposedDate(e.target.value)}
                    className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm"
                  />
                </div>
              )}
            </div>
          )}

          {/* 3. 種類別属性入力欄 */}
          {Object.keys(currentAttributeLabels).length > 0 && (
            <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200 space-y-3">
              <h3 className="text-xs font-bold text-stone-700">
                {category}の追加属性（任意）
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {Object.entries(currentAttributeLabels).map(([attrKey, label]) => {
                  const val = attributes[attrKey] ?? '';
                  const isNumber = attrKey === 'vintageYear';
                  return (
                    <div key={attrKey}>
                      <label className="block text-xs font-medium text-stone-600 mb-1">
                        {label}
                      </label>
                      <input
                        type={isNumber ? 'number' : 'text'}
                        value={val}
                        onChange={(e) => {
                          const v = e.target.value;
                          setAttributes((prev) => ({
                            ...prev,
                            [attrKey]: isNumber ? (v ? Number(v) : '') : v,
                          }));
                        }}
                        placeholder={`例: ${label}`}
                        className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm outline-none"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 4. 購入情報 */}
          <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200 space-y-3">
            <h3 className="text-xs font-bold text-stone-700">購入情報（任意）</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">
                  購入日
                </label>
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">
                  購入価格（円）
                </label>
                <input
                  type="number"
                  value={purchasePriceYen}
                  onChange={(e) => setPurchasePriceYen(e.target.value)}
                  placeholder="例: 3500"
                  min="0"
                  className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                購入場所・店舗
              </label>
              <input
                type="text"
                value={purchasePlace}
                onChange={(e) => setPurchasePlace(e.target.value)}
                placeholder="例: 地元の酒販店、やまや"
                className="w-full min-h-touch px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm"
              />
            </div>
          </div>

          {/* 5. 感想メモとまた買いたい */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-stone-700 mb-1">
                感想・メモ（任意）
              </label>
              <textarea
                value={tastingNote}
                onChange={(e) => setTastingNote(e.target.value)}
                placeholder="味わいや飲んだ際の感想、合わせたい料理など"
                rows={2}
                className="w-full px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-sm outline-none transition"
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="min-h-touch flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={wantToBuyAgain}
                  onChange={(e) => setWantToBuyAgain(e.target.checked)}
                  className="w-5 h-5 rounded text-stone-900 focus:ring-0 border-stone-300 cursor-pointer"
                />
                <span className="text-sm font-semibold text-stone-800">
                  また買いたい（お気に入りに登録）
                </span>
              </label>
            </div>
          </div>

          {/* 送信ボタン */}
          <div className="pt-2 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="w-1/3 min-h-touch bg-stone-200 hover:bg-stone-300 text-stone-800 font-semibold text-sm rounded-xl transition"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-2/3 min-h-touch bg-stone-900 hover:bg-stone-800 text-white font-bold text-sm rounded-xl transition shadow-sm"
            >
              {isSubmitting ? '保存中...' : isEditing ? '更新を保存' : '登録する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
