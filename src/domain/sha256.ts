/**
 * SHA-256 (FIPS 180-4) ハッシュ計算モジュール
 *
 * セキュアコンテキスト（HTTPS / localhost）では標準の高速な Web Crypto API (crypto.subtle.digest) を優先使用する。
 * HTTP の LAN アクセス（例: http://192.168.x.x:5174/）などの非セキュア環境では、
 * crypto.subtle が未定義（undefined）となるため、純粋な JavaScript 実装にフォールバックする。
 * フォールバック処理も標準 SHA-256 と完全に同一の 64 桁小文字 16 進数文字列を返す。
 */

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

// SHA-256 定数 (最初の 64 個の素数の立方根の小数部先頭 32 ビット)
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * FIPS 180-4 準拠の純粋 JavaScript による SHA-256 ハッシュ計算
 * @param bytes 入力バイナリ配列
 * @returns 64 桁の小文字 16 進数文字列
 */
export function sha256Fallback(bytes: Uint8Array): string {
  const byteLength = bytes.length;
  const bitLength = byteLength * 8;
  const paddedLength = Math.ceil((byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[byteLength] = 0x80;

  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;

  padded[paddedLength - 8] = (highBits >>> 24) & 0xff;
  padded[paddedLength - 7] = (highBits >>> 16) & 0xff;
  padded[paddedLength - 6] = (highBits >>> 8) & 0xff;
  padded[paddedLength - 5] = highBits & 0xff;
  padded[paddedLength - 4] = (lowBits >>> 24) & 0xff;
  padded[paddedLength - 3] = (lowBits >>> 16) & 0xff;
  padded[paddedLength - 2] = (lowBits >>> 8) & 0xff;
  padded[paddedLength - 1] = lowBits & 0xff;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] =
        ((padded[idx]! << 24) |
          (padded[idx + 1]! << 16) |
          (padded[idx + 2]! << 8) |
          padded[idx + 3]!) >>>
        0;
    }

    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]!) ^ rotr(18, w[i - 15]!) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(17, w[i - 2]!) ^ rotr(19, w[i - 2]!) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i]! + w[i]!) | 0;
      const s0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const toHex = (v: number): string => (v >>> 0).toString(16).padStart(8, '0');
  return (
    toHex(h0) +
    toHex(h1) +
    toHex(h2) +
    toHex(h3) +
    toHex(h4) +
    toHex(h5) +
    toHex(h6) +
    toHex(h7)
  );
}

/**
 * SHA-256 ハッシュを計算する非同期関数
 * セキュア環境では Web Crypto API を使用し、非セキュア環境では純粋 JS 実装に自動フォールバックする
 */
export async function computeSha256(bytes: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    try {
      const hashBuffer = await globalThis.crypto.subtle.digest(
        'SHA-256',
        bytes as unknown as BufferSource
      );
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toLowerCase();
    } catch {
      // 万一 Web Crypto API の実行に失敗した場合はフォールバックへ
    }
  }

  return sha256Fallback(bytes);
}
