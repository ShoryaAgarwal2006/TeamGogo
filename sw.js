/**
 * sw.js — CivicPulse Service Worker
 *
 * Features:
 *  • Cache-first strategy for app shell assets (offline support)
 *  • Network-first strategy for API calls
 *  • Background Sync: replays queued reports when connectivity returns
 *  • Broadcasts sync completion to all clients
 */

const CACHE_NAME = 'civicpulse-shell-v1';
const SYNC_TAG = 'sync-reports';
const API_ENDPOINT = '/api/reports'; // Adapts to real backend

// Assets to pre-cache on install
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/index.css',
    '/app.js',
    '/idb-store.js',
    '/manifest.json',
];

/* ════════════════════════════════════════════
   INSTALL — Pre-cache app shell
   ════════════════════════════════════════════ */
self.addEventListener('install', (evt) => {
    console.log('[SW] Installing & pre-caching app shell…');
    evt.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
    );
    // Activate immediately — don't wait for old SW tabs to close
    self.skipWaiting();
});

/* ════════════════════════════════════════════
   ACTIVATE — Clean up stale caches
   ════════════════════════════════════════════ */
self.addEventListener('activate', (evt) => {
    console.log('[SW] Activated');
    evt.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== CACHE_NAME)
                    .map((k) => {
                        console.log('[SW] Deleting old cache:', k);
                        return caches.delete(k);
                    })
            )
        ).then(() => self.clients.claim())
    );
});

/* ════════════════════════════════════════════
   FETCH — Cache-first for shell, network-first for API
   ════════════════════════════════════════════ */
self.addEventListener('fetch', (evt) => {
    const { request } = evt;
    const url = new URL(request.url);

    // Skip non-GET requests and cross-origin requests
    if (request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    // API calls → network-first
    if (url.pathname.startsWith('/api/')) {
        evt.respondWith(networkFirst(request));
        return;
    }

    // App shell → cache-first
    evt.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        // Cache successful responses for shell assets
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        // Return offline fallback if we have it
        const fallback = await caches.match('/index.html');
        return fallback ?? new Response('Offline', { status: 503 });
    }
}

async function networkFirst(request) {
    try {
        const response = await fetch(request);
        return response;
    } catch {
        const cached = await caches.match(request);
        return cached ?? new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

/* ════════════════════════════════════════════
   BACKGROUND SYNC — Replay queued reports
   ════════════════════════════════════════════ */
self.addEventListener('sync', (evt) => {
    if (evt.tag === SYNC_TAG) {
        console.log('[SW] Background Sync triggered:', SYNC_TAG);
        evt.waitUntil(syncPendingReports());
    }
});

async function syncPendingReports() {
    // We inline the IndexedDB logic here (can't import ES modules in SW easily
    // across all browsers without a bundler). This mirrors idb-store.js logic.
    const reports = await getAllPendingReports();

    if (!reports.length) {
        console.log('[SW] Background Sync: no pending reports');
        return;
    }

    console.log(`[SW] Background Sync: attempting to sync ${reports.length} report(s)…`);
    let syncedCount = 0;

    for (const report of reports) {
        try {
            const formData = buildFormData(report);
            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                body: formData,
            });

            if (response.ok) {
                await deleteReportById(report.id);
                syncedCount++;
                console.log(`[SW] Synced report id=${report.id}`);
            } else {
                console.warn(`[SW] Server rejected report id=${report.id}: ${response.status}`);
            }
        } catch (err) {
            console.warn(`[SW] Failed to sync report id=${report.id}:`, err.message);
            // Will retry on next sync event
        }
    }

    // Notify all open tabs about sync completion
    const allClients = await self.clients.matchAll({ type: 'window' });
    for (const client of allClients) {
        client.postMessage({
            type: 'sync-complete',
            synced: syncedCount,
            total: reports.length,
        });
    }
}

function buildFormData(report) {
    const fd = new FormData();
    fd.append('category', report.category ?? '');
    fd.append('description', report.description ?? '');
    fd.append('location', report.location ?? '');
    fd.append('gpsLat', report.gpsLat ?? '');
    fd.append('gpsLon', report.gpsLon ?? '');
    fd.append('captureTimestamp', report.captureTimestamp ?? '');
    fd.append('submittedAt', report.createdAt ?? '');
    // Compressed image blob stored as base64 string in IDB
    if (report.imageBase64) {
        const byteString = atob(report.imageBase64);
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
            bytes[i] = byteString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        fd.append('photo', blob, 'report.jpg');
    }
    return fd;
}

/* ── Inline IndexedDB helpers (SW context) ── */
const DB_NAME = 'civicpulse-db';
const DB_VERSION = 1;
const STORE_NAME = 'pendingReports';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (evt) => {
            const db = evt.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getAllPendingReports() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function deleteReportById(id) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => { db.close(); resolve(); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

/* ════════════════════════════════════════════
   PUSH — Show notification when duplicate found
   ════════════════════════════════════════════ */
self.addEventListener('push', (evt) => {
    let data = {};
    try {
        data = evt.data ? evt.data.json() : {};
    } catch {
        data = { body: evt.data?.text() ?? 'New civic update' };
    }

    const title = data.title || 'CivicPulse 🏛️';
    const options = {
        body: data.body || 'Another neighbor just supported your report!',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-96.png',
        // Collapse multiple push events for the same report into one notification
        tag: `support-${data.reportId || 'generic'}`,
        renotify: true,
        data: { reportId: data.reportId, url: '/' },
        actions: [
            { action: 'view', title: '🗺️ View Report' },
            { action: 'dismiss', title: 'Dismiss' },
        ],
    };

    evt.waitUntil(self.registration.showNotification(title, options));
});

/* ════════════════════════════════════════════
   NOTIFICATIONCLICK — Open the app on tap
   ════════════════════════════════════════════ */
self.addEventListener('notificationclick', (evt) => {
    evt.notification.close();

    if (evt.action === 'dismiss') return;

    const targetUrl = evt.notification.data?.url || '/';

    evt.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Focus existing window if open
            const existing = clientList.find((c) => c.url.includes(self.location.origin));
            if (existing) return existing.focus();
            return self.clients.openWindow(targetUrl);
        })
    );
});

/* ════════════════════════════════════════════
   MESSAGE from clients
   ════════════════════════════════════════════ */
self.addEventListener('message', (evt) => {
    if (evt.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
