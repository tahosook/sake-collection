import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import {
  isStaticAssetPath,
  shouldBypassServiceWorker,
  isCacheableHtmlResponse,
  isCacheableStaticAssetResponse,
} from '../src/domain/pwaPolicy';

const ORIGIN = 'https://sake-collection-cs2.pages.dev';

describe('pwaPolicy (Service Worker ポリシー純粋関数)', () => {
  describe('isStaticAssetPath', () => {
    it('アプリシェルの静的アセットパスのみ true を返すこと', () => {
      expect(isStaticAssetPath('/manifest.webmanifest')).toBe(true);
      expect(isStaticAssetPath('/assets/index-abc123.js')).toBe(true);
      expect(isStaticAssetPath('/assets/index-abc123.css')).toBe(true);
      expect(isStaticAssetPath('/icons/icon-192.png')).toBe(true);
      expect(isStaticAssetPath('/icons/icon.svg')).toBe(true);

      expect(isStaticAssetPath('/api/sync-config')).toBe(false);
      expect(isStaticAssetPath('/cdn-cgi/access/login')).toBe(false);
      expect(isStaticAssetPath('/index.html')).toBe(false);
      expect(isStaticAssetPath('/')).toBe(false);
    });
  });

  describe('shouldBypassServiceWorker', () => {
    it('/api/sync-config および /api/* は必ずバイパス（NetworkOnly）すること', () => {
      expect(shouldBypassServiceWorker(`${ORIGIN}/api/sync-config`, 'GET', ORIGIN)).toBe(true);
      expect(shouldBypassServiceWorker(`${ORIGIN}/api/other`, 'GET', ORIGIN)).toBe(true);
    });

    it('GAS (script.google.com) や外部オリジンは必ずバイパスすること', () => {
      expect(
        shouldBypassServiceWorker('https://script.google.com/macros/s/test/exec', 'POST', ORIGIN)
      ).toBe(true);
      expect(
        shouldBypassServiceWorker('https://script.google.com/macros/s/test/exec', 'GET', ORIGIN)
      ).toBe(true);
      expect(
        shouldBypassServiceWorker('https://lh3.googleusercontent.com/photo', 'GET', ORIGIN)
      ).toBe(true);
      expect(
        shouldBypassServiceWorker('https://example.cloudflareaccess.com/login', 'GET', ORIGIN)
      ).toBe(true);
    });

    it('Cloudflare Access (/cdn-cgi/*) と /sw.js 自身は必ずバイパスすること', () => {
      expect(shouldBypassServiceWorker(`${ORIGIN}/cdn-cgi/access/login`, 'GET', ORIGIN)).toBe(true);
      expect(shouldBypassServiceWorker(`${ORIGIN}/cdn-cgi/access/authorized`, 'GET', ORIGIN)).toBe(
        true
      );
      expect(shouldBypassServiceWorker(`${ORIGIN}/sw.js`, 'GET', ORIGIN)).toBe(true);
    });

    it('GET 以外の HTTP メソッドおよび不正 URL は必ずバイパスすること', () => {
      expect(shouldBypassServiceWorker(`${ORIGIN}/`, 'POST', ORIGIN)).toBe(true);
      expect(shouldBypassServiceWorker(`${ORIGIN}/`, 'post', ORIGIN)).toBe(true);
      expect(shouldBypassServiceWorker(`${ORIGIN}/`, 'PUT', ORIGIN)).toBe(true);
      expect(shouldBypassServiceWorker(`${ORIGIN}/`, 'DELETE', ORIGIN)).toBe(true);
      expect(shouldBypassServiceWorker('not-a-valid-url', 'GET', ORIGIN)).toBe(true);
    });

    it('同一オリジンのアプリシェル GET リクエストは SW 処理対象（false）になること', () => {
      expect(shouldBypassServiceWorker(`${ORIGIN}/`, 'GET', ORIGIN)).toBe(false);
      expect(shouldBypassServiceWorker(`${ORIGIN}/index.html`, 'GET', ORIGIN)).toBe(false);
      expect(shouldBypassServiceWorker(`${ORIGIN}/manifest.webmanifest`, 'GET', ORIGIN)).toBe(false);
      expect(shouldBypassServiceWorker(`${ORIGIN}/assets/index-abc.js`, 'GET', ORIGIN)).toBe(false);
      expect(shouldBypassServiceWorker(`${ORIGIN}/icons/icon-192.png`, 'GET', ORIGIN)).toBe(false);
    });
  });

  describe('isCacheableHtmlResponse', () => {
    it('200 OK・非リダイレクト・basic・text/html のみ許可すること', () => {
      expect(isCacheableHtmlResponse(200, false, 'basic', 'text/html; charset=utf-8')).toBe(true);
      expect(isCacheableHtmlResponse(200, false, 'basic', 'text/html')).toBe(true);
    });

    it('Cloudflare Access のリダイレクトや非 200 応答はキャッシュしないこと', () => {
      expect(isCacheableHtmlResponse(200, true, 'basic', 'text/html')).toBe(false);
      expect(isCacheableHtmlResponse(302, false, 'basic', 'text/html')).toBe(false);
      expect(isCacheableHtmlResponse(0, false, 'opaqueredirect', null)).toBe(false);
      expect(isCacheableHtmlResponse(403, false, 'basic', 'text/html')).toBe(false);
      expect(isCacheableHtmlResponse(200, false, 'cors', 'text/html')).toBe(false);
      expect(isCacheableHtmlResponse(200, false, 'basic', 'application/json')).toBe(false);
      expect(isCacheableHtmlResponse(200, false, 'basic', null)).toBe(false);
    });
  });

  describe('isCacheableStaticAssetResponse', () => {
    it('MIME タイプが一致する同一オリジン 200 OK の静的アセットのみ許可すること', () => {
      expect(
        isCacheableStaticAssetResponse(
          '/assets/index-abc.js',
          200,
          false,
          'basic',
          'application/javascript; charset=utf-8'
        )
      ).toBe(true);
      expect(
        isCacheableStaticAssetResponse(
          '/assets/index-abc.js',
          200,
          false,
          'basic',
          'text/javascript'
        )
      ).toBe(true);
      expect(
        isCacheableStaticAssetResponse(
          '/assets/index-abc.css',
          200,
          false,
          'basic',
          'text/css; charset=utf-8'
        )
      ).toBe(true);
      expect(
        isCacheableStaticAssetResponse('/icons/icon-192.png', 200, false, 'basic', 'image/png')
      ).toBe(true);
      expect(
        isCacheableStaticAssetResponse('/icons/icon.svg', 200, false, 'basic', 'image/svg+xml')
      ).toBe(true);
      expect(
        isCacheableStaticAssetResponse(
          '/manifest.webmanifest',
          200,
          false,
          'basic',
          'application/manifest+json'
        )
      ).toBe(true);
    });

    it('Access ログイン HTML 等の MIME 不一致応答やリダイレクト応答を拒否すること', () => {
      expect(
        isCacheableStaticAssetResponse(
          '/assets/index-abc.js',
          200,
          false,
          'basic',
          'text/html; charset=utf-8'
        )
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse('/assets/index-abc.css', 200, false, 'basic', 'text/html')
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse('/icons/icon-192.png', 200, false, 'basic', 'text/html')
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse('/manifest.webmanifest', 200, false, 'basic', 'text/html')
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse(
          '/assets/index-abc.js',
          200,
          true,
          'basic',
          'application/javascript'
        )
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse(
          '/assets/index-abc.js',
          200,
          false,
          'basic',
          null
        )
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse('/api/sync-config', 200, false, 'basic', 'application/json')
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse('/assets/data.json', 200, false, 'basic', 'application/json')
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse('/icons/photo.jpg', 200, false, 'basic', 'image/jpeg')
      ).toBe(false);
      expect(
        isCacheableStaticAssetResponse(
          '/assets/index-abc.js',
          200,
          false,
          'basic',
          'application/notjavascript'
        )
      ).toBe(false);
    });
  });

  describe('public/sw.js ランタイム挙動検証', () => {
    function createSwTestHarness(
      mockFetch: (input: RequestInfo | URL) => Promise<Response>
    ) {
      const store = new Map<string, Map<string, Response>>();
      store.set('__SAKE_CACHE_VERSION__', new Map());
      store.set('sake-shell-old-version', new Map());

      const listeners = new Map<string, (event: unknown) => void>();

      const cacheStorage = {
        open: vi.fn(async (name: string) => {
          let bucket = store.get(name);
          if (!bucket) {
            bucket = new Map();
            store.set(name, bucket);
          }
          return {
            put: vi.fn(async (req: Request | string, res: Response) => {
              const key = typeof req === 'string' ? req : new URL(req.url).pathname;
              bucket!.set(key, res);
            }),
            match: vi.fn(async (req: Request | string) => {
              const key = typeof req === 'string' ? req : new URL(req.url).pathname;
              return bucket!.get(key);
            }),
          };
        }),
        keys: vi.fn(async () => Array.from(store.keys())),
        delete: vi.fn(async (name: string) => store.delete(name)),
      };

      const skipWaiting = vi.fn(async () => undefined);
      const claim = vi.fn(async () => undefined);

      const selfMock = {
        location: { origin: ORIGIN },
        addEventListener: (type: string, handler: (event: unknown) => void) => {
          listeners.set(type, handler);
        },
        skipWaiting,
        clients: { claim },
      };

      const swPath = path.resolve(process.cwd(), 'public/sw.js');
      const swCode = fs.readFileSync(swPath, 'utf8');
      const context = vm.createContext({
        self: selfMock,
        caches: cacheStorage,
        fetch: mockFetch,
        URL,
        Request,
        Response,
      });
      vm.runInContext(swCode, context);

      return { listeners, store, skipWaiting, claim };
    }

    it('/api/sync-config、GAS、/cdn-cgi/* には respondWith せず素通しすること', () => {
      const mockFetch = vi.fn();
      const { listeners } = createSwTestHarness(mockFetch);
      const onFetch = listeners.get('fetch')!;

      for (const url of [
        `${ORIGIN}/api/sync-config`,
        'https://script.google.com/macros/s/test/exec',
        `${ORIGIN}/cdn-cgi/access/login`,
        `${ORIGIN}/sw.js`,
      ]) {
        const respondWith = vi.fn();
        onFetch({
          request: { url, method: 'GET', mode: 'cors' },
          respondWith,
        });
        expect(respondWith).not.toHaveBeenCalled();
      }
    });

    it('ナビゲーションは NetworkFirst で Access リダイレクトをキャッシュせず、オフライン時のみキャッシュを返すこと', async () => {
      let online = true;
      let shouldRedirect = true;

      const mockFetch = vi.fn(async () => {
        if (!online) {
          throw new TypeError('Failed to fetch');
        }
        if (shouldRedirect) {
          return {
            status: 0,
            redirected: false,
            type: 'opaqueredirect',
            headers: new Headers(),
            clone() {
              return this;
            },
          } as unknown as Response;
        }
        return {
          status: 200,
          redirected: false,
          type: 'basic',
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          clone() {
            return this;
          },
        } as unknown as Response;
      });

      const { listeners, store } = createSwTestHarness(mockFetch);
      const onFetch = listeners.get('fetch')!;

      // 1. Access リダイレクト時はキャッシュされず、そのまま返る
      let promise1: Promise<Response> | undefined;
      onFetch({
        request: { url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' },
        respondWith: (p: Promise<Response>) => {
          promise1 = p;
        },
      });
      const res1 = await promise1!;
      expect(res1.type).toBe('opaqueredirect');
      expect(store.get('__SAKE_CACHE_VERSION__')?.has('/')).toBe(false);

      // 2. 認証後の正常 200 text/html はキャッシュに保存される
      shouldRedirect = false;
      let promise2: Promise<Response> | undefined;
      onFetch({
        request: { url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' },
        respondWith: (p: Promise<Response>) => {
          promise2 = p;
        },
      });
      const res2 = await promise2!;
      expect(res2.status).toBe(200);
      expect(store.get('__SAKE_CACHE_VERSION__')?.has('/')).toBe(true);

      // 3. オフライン時はキャッシュされた / を返す
      online = false;
      let promise3: Promise<Response> | undefined;
      onFetch({
        request: { url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' },
        respondWith: (p: Promise<Response>) => {
          promise3 = p;
        },
      });
      const res3 = await promise3!;
      expect(res3.status).toBe(200);
    });

    it('install で skipWaiting、activate で旧キャッシュ削除と clients.claim が実行されること', async () => {
      const { listeners, store, skipWaiting, claim } = createSwTestHarness(vi.fn());

      let installPromise: Promise<unknown> | undefined;
      listeners.get('install')!({
        waitUntil: (p: Promise<unknown>) => {
          installPromise = p;
        },
      });
      await installPromise;
      expect(skipWaiting).toHaveBeenCalledTimes(1);

      let activatePromise: Promise<unknown> | undefined;
      listeners.get('activate')!({
        waitUntil: (p: Promise<unknown>) => {
          activatePromise = p;
        },
      });
      await activatePromise;
      expect(store.has('sake-shell-old-version')).toBe(false);
      expect(store.has('__SAKE_CACHE_VERSION__')).toBe(true);
      expect(claim).toHaveBeenCalledTimes(1);
    });

    it('静的アセットは許可拡張子かつ厳密 MIME 一致のときのみキャッシュし、.json / .jpg / 不正 MIME はキャッシュしないこと', async () => {
      const mimeMap: Record<string, string> = {
        '/assets/index-abc.js': 'application/javascript; charset=utf-8',
        '/assets/bad-mime.js': 'application/notjavascript',
        '/assets/data.json': 'application/json',
        '/icons/photo.jpg': 'image/jpeg',
      };

      const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
        const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const pathname = new URL(reqUrl).pathname;
        return {
          status: 200,
          redirected: false,
          type: 'basic',
          headers: new Headers({ 'content-type': mimeMap[pathname] ?? 'application/octet-stream' }),
          clone() {
            return this;
          },
        } as unknown as Response;
      });

      const { listeners, store } = createSwTestHarness(mockFetch);
      const onFetch = listeners.get('fetch')!;

      for (const pathname of Object.keys(mimeMap)) {
        let resPromise: Promise<Response> | undefined;
        onFetch({
          request: { url: `${ORIGIN}${pathname}`, method: 'GET', mode: 'cors' },
          respondWith: (p: Promise<Response>) => {
            resPromise = p;
          },
        });
        await resPromise!;
      }

      const bucket = store.get('__SAKE_CACHE_VERSION__')!;
      expect(bucket.has('/assets/index-abc.js')).toBe(true);
      expect(bucket.has('/assets/bad-mime.js')).toBe(false);
      expect(bucket.has('/assets/data.json')).toBe(false);
      expect(bucket.has('/icons/photo.jpg')).toBe(false);
    });
  });
});
