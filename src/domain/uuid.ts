/**
 * RFC 4122 v4 準拠の UUID 文字列を生成する共通関数
 *
 * セキュアコンテキスト（HTTPS / localhost）では標準の crypto.randomUUID() を優先使用する。
 * HTTP の LAN アクセス（例: http://192.168.x.x:5174/）など非セキュアコンテキスト環境では、
 * crypto.randomUUID が未定義（undefined）となるため、非セキュア環境でも利用可能な
 * crypto.getRandomValues() を用いた v4 UUID 生成に安全にフォールバックする。
 */
export function generateUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  // フォールバック: crypto.getRandomValues による RFC 4122 v4 UUID 生成
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);

    // RFC 4122 v4 形式:
    // 7バイト目の上位4ビットを 0100 (version 4) に設定
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    // 9バイト目の上位2ビットを 10 (variant 1) に設定
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }

  // フォールバック: 万一どちらも存在しない環境向けの Math.random フォールバック
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
