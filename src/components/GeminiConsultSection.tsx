import React, { useState } from 'react';
import { SakeCategory } from '../types/sake';
import {
  buildGeminiConsultationPrompt,
  parseAndValidateGeminiJson,
  GeminiImportPayload,
} from '../domain/geminiPrompt';
import { getTodayDateString } from '../domain/bottleUtils';
import { CopyIcon, CheckIcon, SparklesIcon } from './Icons';

export interface GeminiConsultSectionProps {
  categoryHint?: SakeCategory;
  onImportPayload: (payload: GeminiImportPayload) => { skippedFields: string[] };
  disabled?: boolean;
}

export const GeminiConsultSection: React.FC<GeminiConsultSectionProps> = ({
  categoryHint = '日本酒',
  onImportPayload,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const [jsonText, setJsonText] = useState<string>('');
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [skippedFields, setSkippedFields] = useState<string[]>([]);
  const [lastImportedName, setLastImportedName] = useState<string | null>(null);

  // プロンプトをクリップボードにコピー
  const handleCopyPrompt = async () => {
    try {
      const today = getTodayDateString();
      const prompt = buildGeminiConsultationPrompt({
        categoryHint,
        todayDate: today,
      });

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      } else {
        // フォールバック
        const ta = document.createElement('textarea');
        ta.value = prompt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      alert(`プロンプトのコピーに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // JSONを取り込み検証
  const handleImport = () => {
    setErrors([]);
    setWarnings([]);
    setSkippedFields([]);
    setLastImportedName(null);

    const trimmed = jsonText.trim();
    if (!trimmed) {
      setErrors(['Gemini の回答から出力された JSON を貼り付けてください。']);
      return;
    }

    const todayDate = getTodayDateString();
    const result = parseAndValidateGeminiJson(trimmed, { todayDate });

    if (!result.success) {
      setErrors(result.errors);
      return;
    }

    // 成功時: 親コンポーネントに反映
    const res = onImportPayload(result.data);
    setLastImportedName(result.data.name);
    setWarnings(result.warnings);
    setSkippedFields(res.skippedFields);
    setJsonText('');
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 overflow-hidden transition shadow-sm">
      {/* アコーディオンヘッダー */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 bg-stone-100 hover:bg-stone-200/80 flex items-center justify-between text-left transition"
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-amber-100 text-amber-900 rounded-lg">
            <SparklesIcon className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-stone-900">
              Gemini 相談で自動入力（プロンプト・JSON取り込み）
            </h3>
            <p className="text-[11px] text-stone-500">
              写真から銘柄・スペック・4部構成解説・相場目安を抽出
            </p>
          </div>
        </div>
        <span className="text-xs font-bold text-stone-500">
          {isOpen ? '閉じる ▲' : '開く ▼'}
        </span>
      </button>

      {isOpen && (
        <div className="p-4 space-y-4 bg-white border-t border-stone-200">
          {/* 1. プロンプトコピー部 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-stone-800">
                ① プロンプトをコピーして Gemini に写真と送信
              </span>
              <span className="text-[11px] text-stone-500">
                種類ヒント: <strong className="text-stone-800">{categoryHint}</strong>
              </span>
            </div>

            {/* 背景写り込みへの注意表示（必須要件: コピーボタン直上） */}
            <p className="text-xs text-amber-800 bg-amber-50 p-2.5 rounded-xl border border-amber-200 leading-relaxed font-medium">
              ※Geminiに写真を添付する際は、部屋の様子や個人情報・反射の写り込みにご注意ください
            </p>

            <button
              type="button"
              disabled={disabled}
              onClick={handleCopyPrompt}
              className={`min-h-touch w-full py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition shadow-sm ${
                copied
                  ? 'bg-emerald-600 text-white'
                  : 'bg-stone-900 hover:bg-stone-800 text-white'
              }`}
            >
              {copied ? (
                <>
                  <CheckIcon className="w-4 h-4" />
                  <span>プロンプトをコピーしました！Geminiに写真と貼り付けてください</span>
                </>
              ) : (
                <>
                  <CopyIcon className="w-4 h-4" />
                  <span>相談プロンプトをコピー</span>
                </>
              )}
            </button>
          </div>

          <hr className="border-stone-100" />

          {/* 2. JSON取り込み部 */}
          <div className="space-y-2">
            <label className="block text-xs font-bold text-stone-800">
              ② Gemini が返した結果 JSON を貼り付けて取り込む
            </label>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              disabled={disabled}
              placeholder={'```json\n{\n  "name": "銘柄名",\n  "category": "' + categoryHint + '",\n  ...\n}\n```'}
              rows={4}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 focus:border-stone-900 focus:bg-white rounded-xl text-xs font-mono outline-none transition"
            />

            <button
              type="button"
              disabled={disabled || !jsonText.trim()}
              onClick={handleImport}
              className="min-h-touch w-full py-2.5 px-4 bg-amber-500 hover:bg-amber-600 disabled:bg-stone-200 text-white disabled:text-stone-400 font-bold text-xs rounded-xl transition shadow-sm flex items-center justify-center gap-1.5"
            >
              <SparklesIcon className="w-4 h-4" />
              <span>結果JSONを取り込む</span>
            </button>
          </div>

          {/* 3. 取り込み結果フィードバック */}
          {/* エラー表示（赤） */}
          {errors.length > 0 && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl space-y-1 font-medium animate-in fade-in duration-200">
              <div className="font-bold">取り込みエラー（内容を確認して修正してください）:</div>
              <ul className="list-disc list-inside space-y-0.5">
                {errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 成功表示（緑） */}
          {lastImportedName && errors.length === 0 && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl space-y-1 font-medium animate-in fade-in duration-200">
              <div className="font-bold flex items-center gap-1.5">
                <CheckIcon className="w-4 h-4 text-emerald-600" />
                <span>「{lastImportedName}」の属性・解説・相場目安を取り込みました！</span>
              </div>
              <p className="text-[11px] text-emerald-700">
                下のフォームで取り込まれた内容を確認・必要に応じて修正してください。
              </p>
            </div>
          )}

          {/* 警告表示（黄/琥珀） */}
          {(warnings.length > 0 || skippedFields.length > 0) && (
            <div className="p-3 bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-xl space-y-1.5 font-medium animate-in fade-in duration-200">
              {skippedFields.length > 0 && (
                <div>
                  <span className="font-bold block">手編集項目の上書き保護:</span>
                  <p className="text-[11px] text-amber-800">
                    ユーザーが手入力・編集済みの項目（{skippedFields.join(', ')}）は上書きせず保持しました。
                  </p>
                </div>
              )}
              {warnings.length > 0 && (
                <div>
                  <span className="font-bold block">取り込み時の注意事項・補正:</span>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-800">
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
