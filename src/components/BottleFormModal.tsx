import React, { useState, useEffect, useMemo } from 'react';
import {
  BottleRecord,
  PhotoRecord,
  SakeCategory,
  SAKE_CATEGORIES,
  BottleStatus,
  BOTTLE_STATUSES,
  CategoryAttributes,
  SakeDescription,
  DescriptionSource,
  ReferencePriceInfo,
} from '../types/sake';
import {
  CreateBottleInput,
  findDuplicateBottles,
  createReuseDraftFromBottle,
} from '../domain/bottleUtils';
import { CATEGORY_ATTRIBUTE_LABELS } from '../domain/categories';
import { isValidCalendarDate } from '../domain/validation';
import { STATUS_LABELS } from '../domain/status';
import {
  processImageFileToPhotoRecord,
  addPhotoToDraft,
  removePhotoFromDraft,
  replacePhotoInDraft,
} from '../domain/photoUtils';
import {
  mergeGeminiPayloadIntoBottle,
  GeminiImportPayload,
} from '../domain/geminiPrompt';
import { CloseIcon, PlusIcon, TrashIcon, ArrowPathIcon } from './Icons';
import { PhotoManagerSection } from './PhotoManagerSection';
import { GeminiConsultSection } from './GeminiConsultSection';
import { ReuseBottlePickerModal } from './ReuseBottlePickerModal';

export interface BottleFormModalProps {
  initialBottle?: BottleRecord | null;
  allBottles?: BottleRecord[];
  photos?: PhotoRecord[];
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    data: CreateBottleInput | BottleRecord,
    options?: {
      quantity?: number;
      draftPhotos?: PhotoRecord[];
    }
  ) => Promise<void>;
}

export const BottleFormModal: React.FC<BottleFormModalProps> = ({
  initialBottle,
  allBottles = [],
  photos = [],
  isOpen,
  onClose,
  onSubmit,
}) => {
  const isEditing = Boolean(initialBottle);
  // 一時的なボトルID（新規登録時の写真の関連付け用）
  const tempBottleId = useMemo(() => initialBottle?.id ?? crypto.randomUUID(), [initialBottle?.id]);

  // モーダル管理（流用ピッカー）
  const [isReuseModalOpen, setIsReuseModalOpen] = useState<boolean>(false);

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

  // 日付フィールド
  const [openedDate, setOpenedDate] = useState<string>(initialBottle?.openedDate ?? '');
  const [finishedDate, setFinishedDate] = useState<string>(initialBottle?.finishedDate ?? '');
  const [disposedDate, setDisposedDate] = useState<string>(initialBottle?.disposedDate ?? '');

  // 種類別属性
  const [attributes, setAttributes] = useState<Record<string, string | number>>(
    (initialBottle?.categoryAttributes as Record<string, string | number>) ?? {}
  );

  // 写真管理
  const [draftPhotos, setDraftPhotos] = useState<PhotoRecord[]>([]);
  const [photoIds, setPhotoIds] = useState<string[]>(initialBottle?.photoIds ?? []);
  const [primaryPhotoId, setPrimaryPhotoId] = useState<string | null>(initialBottle?.primaryPhotoId ?? null);
  const [isProcessingPhotos, setIsProcessingPhotos] = useState<boolean>(false);

  // 解説（4部構成）
  const [summary, setSummary] = useState<string>(initialBottle?.description?.summary ?? '');
  const [tasteProfile, setTasteProfile] = useState<string>(initialBottle?.description?.tasteProfile ?? '');
  const [background, setBackground] = useState<string>(initialBottle?.description?.background ?? '');
  const [servingSuggestion, setServingSuggestion] = useState<string>(initialBottle?.description?.servingSuggestion ?? '');

  // 出典
  const [sources, setSources] = useState<DescriptionSource[]>(initialBottle?.sources ?? []);
  const [newSourceUrl, setNewSourceUrl] = useState<string>('');
  const [newSourceTitle, setNewSourceTitle] = useState<string>('');

  // 相場目安（購入価格とは分離）
  const [estimatedPriceYen, setEstimatedPriceYen] = useState<string>(
    initialBottle?.referencePrice?.estimatedPriceYen !== null &&
    initialBottle?.referencePrice?.estimatedPriceYen !== undefined
      ? String(initialBottle.referencePrice.estimatedPriceYen)
      : ''
  );
  const [fetchedDate, setFetchedDate] = useState<string>(
    initialBottle?.referencePrice?.fetchedDate ?? ''
  );
  const [referencePriceNote, setReferencePriceNote] = useState<string>(
    initialBottle?.referencePrice?.note ?? ''
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

  // 複数本一括登録（新規のみ、1〜10本）
  const [quantity, setQuantity] = useState<number>(1);

  // ユーザーが手動編集した項目名の集合（Gemini JSON 再取り込み時の上書き保護）
  const [userEditedFields, setUserEditedFields] = useState<Set<string>>(
    new Set(initialBottle?.userEditedFields ?? [])
  );

  // エラー・送信状態
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // 手動編集を記録するヘルパー
  const markUserEdited = (fieldKey: string) => {
    setUserEditedFields((prev) => new Set(prev).add(fieldKey));
  };

  // モーダルが開かれた時、初期データをセット
  useEffect(() => {
    if (!isOpen) return;

    setName(initialBottle?.name ?? '');
    setCategory(initialBottle?.category ?? '日本酒');
    setStatus(initialBottle?.status ?? 'unopened');
    setVolumeMl(
      initialBottle?.volumeMl !== null && initialBottle?.volumeMl !== undefined
        ? String(initialBottle.volumeMl)
        : ''
    );
    setAbv(
      initialBottle?.abv !== null && initialBottle?.abv !== undefined
        ? String(initialBottle.abv)
        : ''
    );
    setOpenedDate(initialBottle?.openedDate ?? '');
    setFinishedDate(initialBottle?.finishedDate ?? '');
    setDisposedDate(initialBottle?.disposedDate ?? '');
    setAttributes(
      (initialBottle?.categoryAttributes as Record<string, string | number>) ?? {}
    );

    // 写真の初期化
    if (initialBottle) {
      const existingPhotos = initialBottle.photoIds
        .map((pid) => photos.find((p) => p.id === pid))
        .filter((p): p is PhotoRecord => Boolean(p));
      setDraftPhotos(existingPhotos);
      setPhotoIds(initialBottle.photoIds);
      setPrimaryPhotoId(initialBottle.primaryPhotoId ?? initialBottle.photoIds[0] ?? null);
    } else {
      setDraftPhotos([]);
      setPhotoIds([]);
      setPrimaryPhotoId(null);
    }

    // 解説・出典
    setSummary(initialBottle?.description?.summary ?? '');
    setTasteProfile(initialBottle?.description?.tasteProfile ?? '');
    setBackground(initialBottle?.description?.background ?? '');
    setServingSuggestion(initialBottle?.description?.servingSuggestion ?? '');
    setSources(initialBottle?.sources ? [...initialBottle.sources] : []);
    setNewSourceUrl('');
    setNewSourceTitle('');

    // 相場目安
    setEstimatedPriceYen(
      initialBottle?.referencePrice?.estimatedPriceYen !== null &&
      initialBottle?.referencePrice?.estimatedPriceYen !== undefined
        ? String(initialBottle.referencePrice.estimatedPriceYen)
        : ''
    );
    setFetchedDate(initialBottle?.referencePrice?.fetchedDate ?? '');
    setReferencePriceNote(initialBottle?.referencePrice?.note ?? '');

    // 購入情報
    setPurchaseDate(initialBottle?.purchaseInfo.purchaseDate ?? '');
    setPurchasePlace(initialBottle?.purchaseInfo.purchasePlace ?? '');
    setPurchasePriceYen(
      initialBottle?.purchaseInfo.purchasePriceYen !== null &&
        initialBottle?.purchaseInfo.purchasePriceYen !== undefined
        ? String(initialBottle.purchaseInfo.purchasePriceYen)
        : ''
    );

    setTastingNote(initialBottle?.tastingNote ?? '');
    setWantToBuyAgain(initialBottle?.wantToBuyAgain ?? false);
    setQuantity(1);
    setUserEditedFields(new Set(initialBottle?.userEditedFields ?? []));
    setErrorMessage(null);
    setIsSubmitting(false);
  }, [isOpen, initialBottle, photos]);

  // 重複チェック
  const duplicateInfo = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed || isEditing) {
      return { hasDuplicate: false, breakdown: { inventory: 0, finished: 0, disposed: 0 }, matches: [] };
    }
    const numVol = volumeMl.trim() ? Number(volumeMl) : null;
    const res = findDuplicateBottles(allBottles, {
      name: trimmed,
      category,
      volumeMl: numVol && !isNaN(numVol) ? numVol : null,
    });
    const matches = res.exactMatches.length > 0 ? res.exactMatches : res.nameMatches;
    return {
      hasDuplicate: res.hasDuplicate,
      breakdown: res.breakdown,
      matches,
    };
  }, [name, category, volumeMl, allBottles, isEditing]);

  if (!isOpen) return null;

  // 写真追加ハンドラー
  const handleAddPhotos = async (files: File[]) => {
    setIsProcessingPhotos(true);
    setErrorMessage(null);
    try {
      let currentIds = [...photoIds];
      let currentPrim = primaryPhotoId;
      const newRecords: PhotoRecord[] = [];

      for (const file of files) {
        const record = await processImageFileToPhotoRecord(file, tempBottleId);
        const res = addPhotoToDraft(currentIds, record.id, currentPrim);
        currentIds = res.photoIds;
        currentPrim = res.primaryPhotoId;
        newRecords.push(record);
      }

      setDraftPhotos((prev) => [...prev, ...newRecords]);
      setPhotoIds(currentIds);
      setPrimaryPhotoId(currentPrim);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsProcessingPhotos(false);
    }
  };

  // 写真削除ハンドラー
  const handleRemovePhoto = (photoId: string) => {
    const res = removePhotoFromDraft(photoIds, photoId, primaryPhotoId);
    setPhotoIds(res.photoIds);
    setPrimaryPhotoId(res.primaryPhotoId);
    setDraftPhotos((prev) => prev.filter((p) => p.id !== photoId));
  };

  // 代表写真の変更
  const handleSetPrimaryPhoto = (photoId: string) => {
    setPrimaryPhotoId(photoId);
  };

  // 写真の差し替え
  const handleReplacePhoto = async (photoId: string, file: File) => {
    setIsProcessingPhotos(true);
    setErrorMessage(null);
    try {
      const record = await processImageFileToPhotoRecord(file, tempBottleId);
      const res = replacePhotoInDraft(photoIds, photoId, record.id, primaryPhotoId);
      setPhotoIds(res.photoIds);
      setPrimaryPhotoId(res.primaryPhotoId);
      setDraftPhotos((prev) =>
        prev.map((p) => (p.id === photoId ? record : p))
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsProcessingPhotos(false);
    }
  };

  // Gemini JSON 取り込みハンドラー（手編集項目の上書き保護つき）
  const handleImportGeminiPayload = (payload: GeminiImportPayload) => {
    const numVol = volumeMl.trim() ? Number(volumeMl) : null;
    const numAb = abv.trim() ? Number(abv) : null;
    const numRef = estimatedPriceYen.trim() ? Number(estimatedPriceYen) : null;

    const currentDraft = {
      name,
      category,
      volumeMl: numVol && !isNaN(numVol) ? numVol : null,
      abv: numAb && !isNaN(numAb) ? numAb : null,
      categoryAttributes: attributes as CategoryAttributes,
      description:
        summary || tasteProfile || background || servingSuggestion
          ? ({
              summary,
              tasteProfile,
              background,
              servingSuggestion,
            } as SakeDescription)
          : null,
      sources,
      referencePrice:
        numRef !== null || fetchedDate || referencePriceNote
          ? ({
              estimatedPriceYen: numRef,
              fetchedDate: fetchedDate || null,
              note: referencePriceNote || undefined,
            } as ReferencePriceInfo)
          : null,
    };

    const { merged, skippedFields } = mergeGeminiPayloadIntoBottle(
      currentDraft,
      payload,
      Array.from(userEditedFields)
    );

    // フォームへ反映（取り込み・マージ結果が null の項目は入力欄を空にする）
    setName(merged.name);
    setCategory(merged.category);
    setVolumeMl(merged.volumeMl !== null ? String(merged.volumeMl) : '');
    setAbv(merged.abv !== null ? String(merged.abv) : '');
    setAttributes((merged.categoryAttributes as Record<string, string | number>) ?? {});

    setSummary(merged.description?.summary ?? '');
    setTasteProfile(merged.description?.tasteProfile ?? '');
    setBackground(merged.description?.background ?? '');
    setServingSuggestion(merged.description?.servingSuggestion ?? '');

    setSources(merged.sources ? [...merged.sources] : []);

    setEstimatedPriceYen(
      merged.referencePrice?.estimatedPriceYen !== null &&
      merged.referencePrice?.estimatedPriceYen !== undefined
        ? String(merged.referencePrice.estimatedPriceYen)
        : ''
    );
    setFetchedDate(merged.referencePrice?.fetchedDate ?? '');
    setReferencePriceNote(merged.referencePrice?.note ?? '');

    return { skippedFields };
  };

  // 既存銘柄からの流用ハンドラー
  const handleSelectReuse = (sourceBottle: BottleRecord, copyPhotos: boolean) => {
    const { draft, photosToClone } = createReuseDraftFromBottle(sourceBottle, {
      copyPhotos,
    });

    setName(draft.name);
    setCategory(draft.category);
    setVolumeMl(draft.volumeMl !== null && draft.volumeMl !== undefined ? String(draft.volumeMl) : '');
    setAbv(draft.abv !== null && draft.abv !== undefined ? String(draft.abv) : '');
    setStatus('unopened');
    setOpenedDate('');
    setFinishedDate('');
    setDisposedDate('');
    setAttributes((draft.categoryAttributes as Record<string, string | number>) ?? {});

    // 購入情報はリセット
    setPurchaseDate('');
    setPurchasePlace('');
    setPurchasePriceYen('');
    setTastingNote('');
    setWantToBuyAgain(false);

    // 解説・出典・相場目安
    setSummary(draft.description?.summary ?? '');
    setTasteProfile(draft.description?.tasteProfile ?? '');
    setBackground(draft.description?.background ?? '');
    setServingSuggestion(draft.description?.servingSuggestion ?? '');
    setSources(draft.sources ? [...draft.sources] : []);
    setEstimatedPriceYen(
      draft.referencePrice?.estimatedPriceYen !== null &&
      draft.referencePrice?.estimatedPriceYen !== undefined
        ? String(draft.referencePrice.estimatedPriceYen)
        : ''
    );
    setFetchedDate(draft.referencePrice?.fetchedDate ?? '');
    setReferencePriceNote(draft.referencePrice?.note ?? '');

    // 写真の引き継ぎ
    if (copyPhotos && photosToClone.length > 0) {
      const clonedRecords: PhotoRecord[] = [];
      for (const ptc of photosToClone) {
        const srcPhoto = photos.find((p) => p.id === ptc.sourcePhotoId);
        if (srcPhoto) {
          clonedRecords.push({
            ...srcPhoto,
            id: ptc.newPhotoId,
            bottleId: tempBottleId,
            driveFileId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deleted: false,
          });
        }
      }
      setDraftPhotos(clonedRecords);
      setPhotoIds(draft.photoIds ?? []);
      setPrimaryPhotoId(draft.primaryPhotoId ?? null);
    } else {
      setDraftPhotos([]);
      setPhotoIds([]);
      setPrimaryPhotoId(null);
    }

    // 手動編集フラグはリセット
    setUserEditedFields(new Set());
    setIsReuseModalOpen(false);
  };

  // 出典追加
  const handleAddSource = () => {
    const trimmedUrl = newSourceUrl.trim();
    if (!trimmedUrl) return;

    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      setErrorMessage('出典URLは http:// または https:// から始まる必要があります');
      return;
    }

    setSources((prev) => [
      ...prev,
      {
        url: trimmedUrl,
        ...(newSourceTitle.trim() ? { title: newSourceTitle.trim() } : {}),
      },
    ]);
    setNewSourceUrl('');
    setNewSourceTitle('');
    markUserEdited('sources');
    setErrorMessage(null);
  };

  // 出典削除
  const handleRemoveSource = (index: number) => {
    setSources((prev) => prev.filter((_, i) => i !== index));
    markUserEdited('sources');
  };

  const currentAttributeLabels = CATEGORY_ATTRIBUTE_LABELS[category] ?? {};

  // フォーム送信
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    // 1. 名前チェック
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage('お酒の名前（銘柄名）を入力してください');
      return;
    }

    // 2. 日付チェック
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
    if (fetchedDate) {
      const err = validateDate(fetchedDate, '相場目安の取得日');
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

    // 3. 数値チェック
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

    const numRefPrice = estimatedPriceYen.trim() ? Number(estimatedPriceYen) : null;
    if (numRefPrice !== null && (isNaN(numRefPrice) || numRefPrice < 0)) {
      setErrorMessage('相場目安の推定価格は0以上の数値を入力してください');
      return;
    }

    // 4. 日付正規化
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

    // 5. 属性整理
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

    // 6. 解説
    const hasDesc = summary.trim() || tasteProfile.trim() || background.trim() || servingSuggestion.trim();
    const finalDescription: SakeDescription | null = hasDesc
      ? {
          summary: summary.trim(),
          tasteProfile: tasteProfile.trim(),
          background: background.trim(),
          servingSuggestion: servingSuggestion.trim(),
        }
      : null;

    // 7. 相場目安
    const hasRef = numRefPrice !== null || fetchedDate.trim() || referencePriceNote.trim();
    const finalReferencePrice: ReferencePriceInfo | null = hasRef
      ? {
          estimatedPriceYen: numRefPrice,
          fetchedDate: fetchedDate.trim() || null,
          ...(referencePriceNote.trim() ? { note: referencePriceNote.trim() } : {}),
        }
      : null;

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
          description: finalDescription,
          sources: sources.filter((s) => s.url.trim().length > 0),
          referencePrice: finalReferencePrice,
          photoIds,
          primaryPhotoId,
          userEditedFields: Array.from(userEditedFields),
          updatedAt: new Date().toISOString(),
        } as BottleRecord;
        await onSubmit(updatedBottle, { draftPhotos });
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
          description: finalDescription,
          sources: sources.filter((s) => s.url.trim().length > 0),
          referencePrice: finalReferencePrice,
          photoIds,
          primaryPhotoId,
          userEditedFields: Array.from(userEditedFields),
        } as CreateBottleInput;
        await onSubmit(createInput, { quantity, draftPhotos });
      }
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? 'お酒の編集' : 'お酒の登録'}
      >
        <div className="bg-white w-full max-w-lg min-h-screen sm:min-h-0 sm:max-h-[92vh] sm:rounded-3xl flex flex-col shadow-2xl overflow-hidden animate-in fade-in duration-200">
          {/* ヘッダー */}
          <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-base sm:text-lg font-bold text-stone-900">
                {isEditing ? 'お酒を編集' : 'お酒を登録'}
              </h2>
              {!isEditing && (
                <button
                  type="button"
                  onClick={() => setIsReuseModalOpen(true)}
                  className="min-h-touch px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-xl text-xs font-bold flex items-center gap-1 transition shadow-sm"
                >
                  <ArrowPathIcon className="w-3.5 h-3.5" />
                  <span>既存銘柄から流用</span>
                </button>
              )}
            </div>
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
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl font-medium animate-in fade-in duration-200">
                {errorMessage}
              </div>
            )}

            {/* 重複警告バナー */}
            {duplicateInfo.hasDuplicate && (
              <div className="p-3.5 bg-amber-50 border border-amber-200 text-amber-950 rounded-2xl space-y-2 text-xs animate-in fade-in duration-200">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <span className="font-bold block">
                      同じ銘柄『{duplicateInfo.matches[0]?.name}』が既に登録されています
                    </span>
                    <p className="text-[11px] text-amber-800">
                      家にある酒: <strong>{duplicateInfo.breakdown.inventory}本</strong> /
                      飲んだ記録: <strong>{duplicateInfo.breakdown.finished}本</strong> /
                      手放した酒: <strong>{duplicateInfo.breakdown.disposed}本</strong>
                    </p>
                  </div>
                  {duplicateInfo.matches[0] && (
                    <button
                      type="button"
                      onClick={() => handleSelectReuse(duplicateInfo.matches[0]!, true)}
                      className="min-h-touch px-3 py-1.5 bg-amber-900 hover:bg-amber-800 text-white font-bold text-xs rounded-xl whitespace-nowrap transition shadow-sm flex-shrink-0"
                    >
                      この銘柄から流用する
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ① 写真を選ぶセクション */}
            <div className="p-4 bg-stone-50 rounded-2xl border border-stone-200 space-y-3">
              <PhotoManagerSection
                photos={draftPhotos}
                primaryPhotoId={primaryPhotoId}
                isProcessing={isProcessingPhotos}
                onAddFiles={handleAddPhotos}
                onRemovePhoto={handleRemovePhoto}
                onSetPrimaryPhoto={handleSetPrimaryPhoto}
                onReplaceFile={handleReplacePhoto}
                disabled={isSubmitting}
              />
            </div>

            {/* ②・③ Gemini 相談・取り込みセクション */}
            <GeminiConsultSection
              categoryHint={category}
              onImportPayload={handleImportGeminiPayload}
              disabled={isSubmitting}
            />

            {/* ④ 確認・修正：基本情報 */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-stone-700">基本スペック</h3>
              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  名前・銘柄名 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    markUserEdited('name');
                  }}
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
                    onChange={(e) => {
                      const newCat = e.target.value as SakeCategory;
                      setCategory(newCat);
                      setAttributes({});
                      markUserEdited('category');
                    }}
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
                    onChange={(e) => {
                      setVolumeMl(e.target.value);
                      markUserEdited('volumeMl');
                    }}
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
                    onChange={(e) => {
                      setAbv(e.target.value);
                      markUserEdited('abv');
                    }}
                    placeholder="例: 15.5"
                    min="0"
                    max="100"
                    className="w-full min-h-touch px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-sm outline-none transition"
                  />
                </div>
              </div>
            </div>

            {/* 状態連動の日付欄 */}
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

            {/* 種類別属性入力欄 */}
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
                            markUserEdited(`categoryAttributes.${attrKey}`);
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

            {/* お酒の解説（4部構成） */}
            <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200 space-y-3">
              <div>
                <h3 className="text-xs font-bold text-stone-700">お酒の解説（4部構成・任意）</h3>
                <p className="text-[11px] text-stone-500">
                  目安300〜500字。Gemini 相談で自動入力、または手入力・修正できます。
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">
                  ① ひとことで
                </label>
                <textarea
                  value={summary}
                  onChange={(e) => {
                    setSummary(e.target.value);
                    markUserEdited('description.summary');
                  }}
                  placeholder="例: 洋梨のような華やかな香りと透明感のあるキレが際立つ一本"
                  rows={2}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl text-xs outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">
                  ② 味わい
                </label>
                <textarea
                  value={tasteProfile}
                  onChange={(e) => {
                    setTasteProfile(e.target.value);
                    markUserEdited('description.tasteProfile');
                  }}
                  placeholder="例: 上品な甘みと爽やかな酸味が調和し、口に含むと心地よい余韻が続きます"
                  rows={2}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl text-xs outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">
                  ③ 背景・歴史
                </label>
                <textarea
                  value={background}
                  onChange={(e) => {
                    setBackground(e.target.value);
                    markUserEdited('description.background');
                  }}
                  placeholder="例: 山口県岩国市の旭酒造が手掛ける純米大吟醸。山田錦を45%まで磨き上げて仕込んでいます"
                  rows={2}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl text-xs outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">
                  ④ おすすめの飲み方
                </label>
                <textarea
                  value={servingSuggestion}
                  onChange={(e) => {
                    setServingSuggestion(e.target.value);
                    markUserEdited('description.servingSuggestion');
                  }}
                  placeholder="例: 10〜12℃に冷やしてワイングラスで楽しむのがおすすめ。白身魚の刺身やカルパッチョと好相性"
                  rows={2}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl text-xs outline-none"
                />
              </div>

              {/* 出典 URL リスト */}
              <div className="pt-2 border-t border-stone-200 space-y-2">
                <label className="block text-xs font-bold text-stone-700">出典（任意）</label>
                {sources.length > 0 && (
                  <ul className="space-y-1.5">
                    {sources.map((src, i) => (
                      <li
                        key={i}
                        className="p-2 bg-white rounded-xl border border-stone-200 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          {src.title && <span className="font-bold block truncate">{src.title}</span>}
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-stone-500 hover:text-stone-900 underline truncate block"
                          >
                            {src.url}
                          </a>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveSource(i)}
                          className="min-h-touch min-w-touch p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg flex items-center justify-center flex-shrink-0"
                          aria-label="出典を削除"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="url"
                      value={newSourceUrl}
                      onChange={(e) => setNewSourceUrl(e.target.value)}
                      placeholder="出典URL (https://...)"
                      className="w-full min-h-touch px-3 py-1.5 bg-white border border-stone-300 rounded-xl text-xs outline-none"
                    />
                    <input
                      type="text"
                      value={newSourceTitle}
                      onChange={(e) => setNewSourceTitle(e.target.value)}
                      placeholder="出典タイトル（任意）"
                      className="w-full min-h-touch px-3 py-1.5 bg-white border border-stone-300 rounded-xl text-xs outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAddSource}
                    disabled={!newSourceUrl.trim()}
                    className="min-h-touch px-3 py-1.5 bg-stone-200 hover:bg-stone-300 disabled:opacity-50 text-stone-800 font-bold text-xs rounded-xl transition flex items-center justify-center gap-1"
                  >
                    <PlusIcon className="w-3.5 h-3.5" />
                    <span>出典を追加</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 相場目安（購入価格とは分離） */}
            <div className="p-3.5 bg-amber-50/70 rounded-2xl border border-amber-200 space-y-3">
              <div>
                <h3 className="text-xs font-bold text-amber-900">相場目安（市場参考値・任意）</h3>
                <p className="text-[11px] text-amber-800">
                  ※購入価格とは構造上完全に分離されています。Gemini 相談で取得または手入力可能。
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-amber-900 mb-1">
                    推定相場（円・税込目安）
                  </label>
                  <input
                    type="number"
                    value={estimatedPriceYen}
                    onChange={(e) => {
                      setEstimatedPriceYen(e.target.value);
                      markUserEdited('referencePrice');
                    }}
                    placeholder="例: 1800"
                    min="0"
                    className="w-full min-h-touch px-3 py-2 bg-white border border-amber-300 rounded-xl text-sm outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-amber-900 mb-1">
                    取得日
                  </label>
                  <input
                    type="date"
                    value={fetchedDate}
                    onChange={(e) => {
                      setFetchedDate(e.target.value);
                      markUserEdited('referencePrice');
                    }}
                    className="w-full min-h-touch px-3 py-2 bg-white border border-amber-300 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-amber-900 mb-1">
                  相場の補足メモ
                </label>
                <input
                  type="text"
                  value={referencePriceNote}
                  onChange={(e) => {
                    setReferencePriceNote(e.target.value);
                    markUserEdited('referencePrice');
                  }}
                  placeholder="例: 公式通販直販価格、限定出荷品など"
                  className="w-full min-h-touch px-3 py-2 bg-white border border-amber-300 rounded-xl text-xs outline-none"
                />
              </div>
            </div>

            {/* 購入情報 */}
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

            {/* 感想メモとまた買いたい */}
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

            {/* 新規登録時のみ: 登録本数（1〜10本） */}
            {!isEditing && (
              <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-stone-700">登録本数</h3>
                    <p className="text-[11px] text-stone-500">
                      同じ銘柄を複数本同時に登録できます（各ボトル独立管理）
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={quantity <= 1}
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      className="min-h-touch min-w-touch p-2 bg-white border border-stone-300 hover:bg-stone-100 disabled:opacity-40 rounded-xl font-bold text-sm flex items-center justify-center transition"
                      aria-label="本数を1減らす"
                    >
                      −
                    </button>
                    <span className="w-8 text-center text-sm font-bold text-stone-900">
                      {quantity}
                    </span>
                    <button
                      type="button"
                      disabled={quantity >= 10}
                      onClick={() => setQuantity((q) => Math.min(10, q + 1))}
                      className="min-h-touch min-w-touch p-2 bg-white border border-stone-300 hover:bg-stone-100 disabled:opacity-40 rounded-xl font-bold text-sm flex items-center justify-center transition"
                      aria-label="本数を1増やす"
                    >
                      ＋
                    </button>
                  </div>
                </div>
                {quantity > 1 && (
                  <p className="text-[11px] text-amber-800 bg-amber-50 p-2 rounded-lg font-medium">
                    ※同じ内容で {quantity} 本のボトルを一括登録します。写真は各ボトルに個別に複製されます。
                  </p>
                )}
              </div>
            )}

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
                disabled={isSubmitting || isProcessingPhotos}
                className="w-2/3 min-h-touch bg-stone-900 hover:bg-stone-800 text-white font-bold text-sm rounded-xl transition shadow-sm flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <span>保存中...</span>
                ) : isEditing ? (
                  <span>更新を保存</span>
                ) : quantity > 1 ? (
                  <span>{quantity}本まとめて登録する</span>
                ) : (
                  <span>登録する</span>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* 流用銘柄ピッカーモーダル */}
      {isReuseModalOpen && (
        <ReuseBottlePickerModal
          isOpen={isReuseModalOpen}
          allBottles={allBottles}
          photos={photos}
          onClose={() => setIsReuseModalOpen(false)}
          onSelectBottle={handleSelectReuse}
        />
      )}
    </>
  );
};
