/**
 * PWA Service Worker キャッシュ・バイパス判定ポリシー（純粋関数）
 *
 * 設計: docs/pwa-design.md §3.2
 * 目的:
 * - /api/*（/api/sync-config 等）、GAS（script.google.com 等）、/cdn-cgi/*（Cloudflare Access）を
 *   絶対にキャッシュさせない（NetworkOnly / Service Worker 非介入）。
 * - Cloudflare Access セッション切れ時のリダイレクト応答やログイン画面 HTML が
 *   アプリシェルキャッシュ（HTML / JS / CSS / 画像）に混入することを防止する。
 */

/**
 * CacheFirst の対象となるアプリシェル静的アセットのパスかを判定する
 */
export function isStaticAssetPath(pathname: string): boolean {
  return (
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/')
  );
}

/**
 * Service Worker がリクエストに介入せず素通し（NetworkOnly）にすべきかを判定する
 *
 * 以下のいずれかに該当する場合は true（バイパス）を返す:
 * - GET 以外の HTTP メソッド（POST 等の同期通信）
 * - 不正な URL 文字列
 * - 異なるオリジンへの通信（script.google.com, googleusercontent.com, cloudflareaccess.com 等）
 * - /api/ 配下（/api/sync-config を含む Pages Functions）
 * - /cdn-cgi/ 配下（Cloudflare Access 認証・コールバック等）
 * - /sw.js 自身
 */
export function shouldBypassServiceWorker(
  requestUrl: string,
  method: string,
  currentOrigin: string
): boolean {
  if (method.toUpperCase() !== 'GET') {
    return true;
  }

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return true;
  }

  if (url.origin !== currentOrigin) {
    return true;
  }

  if (url.pathname === '/api/sync-config' || url.pathname.startsWith('/api/')) {
    return true;
  }

  if (url.pathname.startsWith('/cdn-cgi/')) {
    return true;
  }

  if (url.pathname === '/sw.js') {
    return true;
  }

  return false;
}

/**
 * ナビゲーション応答（HTML）をアプリシェルキャッシュに保存してよいかを判定する
 *
 * 200 OK、非リダイレクト、同一オリジン（basic）、かつ text/html のみ許可する。
 */
export function isCacheableHtmlResponse(
  status: number,
  redirected: boolean,
  responseType: string,
  contentType: string | null
): boolean {
  if (status !== 200 || redirected || responseType !== 'basic') {
    return false;
  }

  if (!contentType) {
    return false;
  }

  return contentType.toLowerCase().includes('text/html');
}

/**
 * 静的アセット応答をキャッシュに保存してよいかを判定する
 *
 * 200 OK、非リダイレクト、同一オリジン（basic）に加え、
 * 拡張子と Content-Type の整合性を検査し、Access ログイン HTML 等の誤キャッシュを防止する。
 */
export function isCacheableStaticAssetResponse(
  pathname: string,
  status: number,
  redirected: boolean,
  responseType: string,
  contentType: string | null
): boolean {
  if (!isStaticAssetPath(pathname)) {
    return false;
  }

  if (status !== 200 || redirected || responseType !== 'basic') {
    return false;
  }

  if (!contentType) {
    return false;
  }

  const mime = (contentType.toLowerCase().split(';')[0] ?? '').trim();
  if (!mime || mime.includes('text/html')) {
    return false;
  }

  const lowerPath = pathname.toLowerCase();
  if (lowerPath.endsWith('.js') || lowerPath.endsWith('.mjs')) {
    return mime.includes('javascript');
  }
  if (lowerPath.endsWith('.css')) {
    return mime === 'text/css';
  }
  if (lowerPath.endsWith('.png')) {
    return mime === 'image/png';
  }
  if (lowerPath.endsWith('.svg')) {
    return mime === 'image/svg+xml';
  }
  if (lowerPath.endsWith('.webmanifest')) {
    return mime === 'application/manifest+json' || mime === 'application/json';
  }

  return true;
}
