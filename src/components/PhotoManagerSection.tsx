import React, { useRef } from 'react';
import { PhotoRecord } from '../types/sake';
import { MAX_PHOTO_COUNT } from '../domain/photoUtils';
import { PlusIcon, TrashIcon, EditIcon } from './Icons';

export interface PhotoManagerSectionProps {
  photos: PhotoRecord[];
  primaryPhotoId: string | null;
  isProcessing?: boolean;
  onAddFiles: (files: File[]) => Promise<void>;
  onRemovePhoto: (photoId: string) => void;
  onSetPrimaryPhoto: (photoId: string) => void;
  onReplaceFile: (photoId: string, file: File) => Promise<void>;
  disabled?: boolean;
}

export const PhotoManagerSection: React.FC<PhotoManagerSectionProps> = ({
  photos,
  primaryPhotoId,
  isProcessing = false,
  onAddFiles,
  onRemovePhoto,
  onSetPrimaryPhoto,
  onReplaceFile,
  disabled = false,
}) => {
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const remainingSlots = Math.max(0, MAX_PHOTO_COUNT - photos.length);
  const isFull = remainingSlots === 0;

  const handleAddChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files).slice(0, remainingSlots);
    await onAddFiles(fileList);

    // 同じファイルを再度選択できるようにリセット
    if (addInputRef.current) {
      addInputRef.current.value = '';
    }
  };

  const handleReplaceChange = async (
    photoId: string,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file) {
      await onReplaceFile(photoId, file);
    }
    e.target.value = '';
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-bold text-stone-700">
            写真（最大{MAX_PHOTO_COUNT}枚）
          </h3>
          <p className="text-[11px] text-stone-500">
            ラベル正面・裏ラベル・箱など（未指定時は1枚目が代表写真）
          </p>
        </div>
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded-full ${
            isFull
              ? 'bg-amber-100 text-amber-800'
              : 'bg-stone-100 text-stone-600'
          }`}
        >
          {photos.length} / {MAX_PHOTO_COUNT}枚
        </span>
      </div>

      {/* 処理中インジケータ */}
      {isProcessing && (
        <div className="p-2.5 bg-stone-100 border border-stone-200 text-stone-700 text-xs rounded-xl flex items-center justify-center gap-2 animate-pulse">
          <div className="w-3.5 h-3.5 border-2 border-stone-600 border-t-transparent rounded-full animate-spin" />
          <span>写真処理中（リサイズ・JPEG圧縮・EXIF除去）...</span>
        </div>
      )}

      {/* サムネイル一覧グリッド */}
      {photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {photos.map((photo, index) => {
            const isPrimary =
              photo.id === primaryPhotoId ||
              (!primaryPhotoId && index === 0);

            return (
              <div
                key={photo.id}
                className={`relative rounded-2xl overflow-hidden border bg-stone-50 flex flex-col ${
                  isPrimary
                    ? 'border-amber-400 ring-2 ring-amber-400/30'
                    : 'border-stone-200'
                }`}
              >
                {/* 画像プレビュー */}
                <div className="relative aspect-square w-full bg-stone-200 overflow-hidden">
                  <img
                    src={photo.dataUrl}
                    alt={`写真 ${index + 1}`}
                    className="w-full h-full object-cover"
                  />
                  {/* 代表写真バッジ */}
                  {isPrimary && (
                    <span className="absolute top-2 left-2 bg-amber-500 text-white text-[11px] font-bold px-2 py-0.5 rounded-full shadow-sm">
                      ★ 代表
                    </span>
                  )}
                </div>

                {/* 操作アクション */}
                <div className="p-2 flex flex-col gap-1.5 bg-white border-t border-stone-100">
                  {!isPrimary && (
                    <button
                      type="button"
                      disabled={disabled || isProcessing}
                      onClick={() => onSetPrimaryPhoto(photo.id)}
                      className="min-h-touch w-full py-1.5 px-2 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-bold rounded-xl border border-amber-200 transition text-center"
                    >
                      代表にする
                    </button>
                  )}

                  <div className="flex gap-1.5">
                    {/* 差し替えボタン */}
                    <label
                      htmlFor={`replace-file-${photo.id}`}
                      className={`min-h-touch flex-1 flex items-center justify-center gap-1 py-1.5 px-2 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold rounded-xl cursor-pointer transition ${
                        disabled || isProcessing
                          ? 'opacity-50 pointer-events-none'
                          : ''
                      }`}
                    >
                      <EditIcon className="w-3.5 h-3.5 text-stone-500" />
                      <span>差し替え</span>
                    </label>
                    <input
                      id={`replace-file-${photo.id}`}
                      type="file"
                      accept="image/*"
                      disabled={disabled || isProcessing}
                      onChange={(e) => handleReplaceChange(photo.id, e)}
                      className="hidden"
                    />

                    {/* 削除ボタン */}
                    <button
                      type="button"
                      disabled={disabled || isProcessing}
                      onClick={() => onRemovePhoto(photo.id)}
                      aria-label={`写真 ${index + 1} を削除`}
                      className="min-h-touch min-w-touch p-2 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-xl border border-rose-200 flex items-center justify-center transition"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 写真追加ボタン */}
      <div>
        <input
          ref={addInputRef}
          type="file"
          accept="image/*"
          multiple
          disabled={disabled || isProcessing || isFull}
          onChange={handleAddChange}
          className="hidden"
        />
        <button
          type="button"
          disabled={disabled || isProcessing || isFull}
          onClick={() => addInputRef.current?.click()}
          className={`min-h-touch w-full py-3 px-4 rounded-2xl border-2 border-dashed flex items-center justify-center gap-2 font-bold text-xs transition ${
            isFull
              ? 'border-stone-200 bg-stone-50 text-stone-400 cursor-not-allowed'
              : 'border-stone-300 hover:border-stone-900 bg-stone-50 hover:bg-white text-stone-700 hover:text-stone-900 shadow-sm'
          }`}
        >
          <PlusIcon className="w-4 h-4" />
          <span>
            {isFull
              ? `写真上限（${MAX_PHOTO_COUNT}枚）に達しています`
              : photos.length === 0
              ? '+ 写真を選択（表・裏・箱など複数可）'
              : `+ 写真を追加（残り${remainingSlots}枚）`}
          </span>
        </button>
      </div>
    </div>
  );
};
