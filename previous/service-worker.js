'use strict';
// Offline cache for the game (classic worker script, no imports).
// The build id below is replaced by qa/release-verification/stamp-build.mjs; an unstamped dev copy keeps 'dev'.
const BUILD_ID = 'offline-e1b9594661';
const CACHE_PREFIX = 'kr-offline';

// Single source of the runtime file set: the whole package (tools/package-demo.mjs) plus the scope root './'.
const RUNTIME_FILES = [
  './', './index.html', './styles.css', './main.mjs', './motion.mjs', './journal.mjs', './storage.mjs', './economy.mjs', './offline.mjs',
  './core/game.mjs', './core/generator.mjs', './core/persistence.mjs', './core/fields.mjs',
  './manifest.webmanifest', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png',
  './service-worker.js',
];

const SCOPE = new URL(self.registration.scope);
const BASE = new URL('./', self.location.href);
const RUNTIME_URLS = RUNTIME_FILES.map((file) => new URL(file, BASE).href);
const ROOT_URL = new URL('./', BASE).href;
const INDEX_URL = new URL('./index.html', BASE).href;
// One cache per build id and per scope: a root worker and a nested worker (previous/) never share or delete each other's caches.
const SCOPE_PREFIX = `${CACHE_PREFIX}|${encodeURIComponent(SCOPE.pathname)}|`;
const CACHE_NAME = SCOPE_PREFIX + BUILD_ID;

async function precache() {
  // Everything is fetched (bypassing the HTTP cache) and verified before any cache is touched: all or nothing.
  const entries = await Promise.all(RUNTIME_URLS.map(async (url) => {
    const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
    if (!response || response.status !== 200 || response.redirected) throw new Error(`Offline precache failed: ${url}`);
    return [url, response];
  }));
  const existed = await caches.has(CACHE_NAME);
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const [url, response] of entries) await cache.put(url, response);
  } catch (error) {
    if (!existed) await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function cacheComplete() {
  try {
    if (!(await caches.has(CACHE_NAME))) return false;
    const cache = await caches.open(CACHE_NAME);
    for (const url of RUNTIME_URLS) if (!(await cache.match(url))) return false;
    return true;
  } catch {
    return false;
  }
}

// The cache key for a request this worker answers, or null when the request is left to the browser.
function cacheKey(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return null;
  const key = url.origin + url.pathname;
  if (!RUNTIME_URLS.includes(key)) return null;
  if (request.mode === 'navigate') return key === ROOT_URL || key === INDEX_URL ? key : null;
  return url.search === '' || url.search === `?v=${BUILD_ID}` ? key : null;
}

async function answer(key, request) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = (await cache.match(key)) || (request.mode === 'navigate' ? await cache.match(INDEX_URL) : undefined);
    if (hit) return hit;
  } catch { /* fall back to the network */ }
  return fetch(request);
}

self.addEventListener('install', (event) => {
  // No skipWaiting(): a new version never replaces the files of a running game; it takes over at the next launch.
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const older = (await caches.keys()).filter((name) => name.startsWith(SCOPE_PREFIX) && name !== CACHE_NAME);
    await Promise.all(older.map((name) => caches.delete(name)));
    // Only the very first version of this scope (no older cache existed) takes the already open page.
    if (older.length === 0) await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const key = cacheKey(event.request);
  if (key) event.respondWith(answer(key, event.request));
});

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!event.data || event.data.type !== 'offline-status' || !port) return;
  event.waitUntil(cacheComplete().then((complete) => port.postMessage({ type: 'offline-status', buildId: BUILD_ID, complete })));
});
