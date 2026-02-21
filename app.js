/**
 * app.js — CivicPulse Main Application
 *
 * Orchestrates:
 *  • Service Worker registration (offline + background sync)
 *  • Web Worker image pipeline (compress + EXIF strip + GPS signature)
 *  • Online/offline UI state
 *  • Form submission: online → fetch API, offline → IndexedDB queue
 *  • Offline queue display
 *  • SW message handler (sync-complete notification)
 */

import { saveReport, getPendingReports, deleteReport, countPendingReports, clearAllReports } from './idb-store.js';

/* ════════════════════════════════════════════
   DOM References
   ════════════════════════════════════════════ */
const offlineBanner = document.getElementById('offline-banner');
const syncToast = document.getElementById('sync-toast');
const syncToastMsg = document.getElementById('sync-toast-msg');
const onlineDot = document.getElementById('online-dot');

const reportForm = document.getElementById('report-form');
const categoryField = document.getElementById('category');
const descField = document.getElementById('description');
const charCount = document.getElementById('char-count');
const locationField = document.getElementById('location');
const locationDetailField = document.getElementById('location-detail');
const locDetailCount = document.getElementById('loc-detail-count');
const gpsBtn = document.getElementById('gps-btn');
const gpsStatus = document.getElementById('gps-status');

const dropZone = document.getElementById('drop-zone');
const photoInput = document.getElementById('photo-input');
const compressionPanel = document.getElementById('compression-panel');
const progressBar = document.getElementById('progress-bar');
const compressionPct = document.getElementById('compression-pct');
const compressionStats = document.getElementById('compression-stats');
const statOriginal = document.getElementById('stat-original');
const statCompressed = document.getElementById('stat-compressed');
const statSavings = document.getElementById('stat-savings');
const previewContainer = document.getElementById('preview-container');
const photoPreview = document.getElementById('photo-preview');
const removePhotoBtn = document.getElementById('remove-photo-btn');

const signatureCard = document.getElementById('signature-card');
const sigTimestamp = document.getElementById('sig-timestamp');
const sigLat = document.getElementById('sig-lat');
const sigLon = document.getElementById('sig-lon');

const submitBtn = document.getElementById('submit-btn');
const submitLabel = document.getElementById('submit-label');

const queueCard = document.getElementById('queue-card');
const queueCountBadge = document.getElementById('queue-count-badge');
const queueList = document.getElementById('queue-list');
const clearQueueBtn = document.getElementById('clear-queue-btn');

clearQueueBtn.addEventListener('click', async () => {
    if (!confirm('Discard all queued reports? This cannot be undone.')) return;
    await clearAllReports();
    showToast('🗑️ Offline queue cleared');
    refreshQueueDisplay();
});

// Phase 2 — Spatial Response Card
const responseCard = document.getElementById('response-card');
const responseIcon = document.getElementById('response-icon');
const responseTitle = document.getElementById('response-title');
const responseMsg = document.getElementById('response-msg');
const responseWard = document.getElementById('response-ward');
const responseZone = document.getElementById('response-zone');
const responseOfficer = document.getElementById('response-officer');
const responseSupporters = document.getElementById('response-supporters');
const responseSupportRow = document.getElementById('response-supporters-row');
const responseWardRow = document.getElementById('response-ward-row');
const responseZoneRow = document.getElementById('response-zone-row');
const responseOfficerRow = document.getElementById('response-officer-row');
const responseId = document.getElementById('response-id');
const mergeBanner = document.getElementById('merge-banner');
const mergeMsg = document.getElementById('merge-msg');

// Push Notifications
const notifBtn = document.getElementById('notif-btn');
const notifBtnLabel = document.getElementById('notif-btn-label');

/* ════════════════════════════════════════════
   State
   ════════════════════════════════════════════ */
let compressedBlob = null;   // Result from Web Worker
let digitalSignature = {};     // { gpsLat, gpsLon, captureTimestamp }
let imageWorker = null;   // Current Web Worker instance
let gpsAcquired = false;      // Phase 5: GPS is mandatory

// Phase 5: Reporter token for "my reports" tracking
let reporterToken = localStorage.getItem('civicpulse-reporter-token');
if (!reporterToken) {
    reporterToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('civicpulse-reporter-token', reporterToken);
}

/* ════════════════════════════════════════════
   1. Service Worker Registration
   ════════════════════════════════════════════ */
async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        console.warn('[App] Service Workers not supported');
        return;
    }
    try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        console.log('[App] Service Worker registered:', reg.scope);

        // Listen for messages from SW (e.g. sync-complete)
        navigator.serviceWorker.addEventListener('message', onSWMessage);

        // Register for background sync if available
        if ('sync' in reg) {
            console.log('[App] Background Sync API available');
        } else {
            console.warn('[App] Background Sync not supported — will use manual retry');
        }
    } catch (err) {
        console.error('[App] Service Worker registration failed:', err);
    }
}

function onSWMessage(evt) {
    const { type, synced, total } = evt.data ?? {};
    if (type === 'sync-complete') {
        console.log(`[App] SW synced ${synced}/${total} report(s)`);
        showToast(`✅ ${synced} report${synced !== 1 ? 's' : ''} synced successfully!`);
        refreshQueueDisplay();
        // Also flush any remaining queued reports immediately
        flushOfflineQueue();
    }
}

/* ════════════════════════════════════════════
   2. Online / Offline Status
   ════════════════════════════════════════════ */
function updateOnlineStatus() {
    const isOnline = navigator.onLine;
    offlineBanner.hidden = isOnline;
    onlineDot.classList.toggle('offline', !isOnline);
    submitLabel.textContent = 'Submit Report';
}

window.addEventListener('online', () => {
    updateOnlineStatus();
    // When back online, flush queued reports immediately
    flushOfflineQueue();
    // Also attempt a manual sync if BG Sync isn't supported
    tryManualSync();
});
window.addEventListener('offline', updateOnlineStatus);

async function tryManualSync() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        if ('sync' in reg) {
            await reg.sync.register('sync-reports');
            console.log('[App] Background Sync registered after reconnect');
        }
    } catch (err) {
        console.warn('[App] Could not register background sync:', err);
    }
}

/* ════════════════════════════════════════════
   3. Character Counter
   ════════════════════════════════════════════ */
descField.addEventListener('input', () => {
    charCount.textContent = descField.value.length;
});

locationDetailField.addEventListener('input', () => {
    locDetailCount.textContent = locationDetailField.value.length;
});

/* ════════════════════════════════════════════
   4. GPS Button
   ════════════════════════════════════════════ */

/** Reverse-geocode lat/lon → human readable address via Nominatim */
async function reverseGeocode(lat, lon) {
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
            { headers: { 'Accept-Language': 'en' } }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.display_name || null;
    } catch {
        return null;
    }
}

/** Set location from coordinates — also fills the text field with address */
async function applyLocation(lat, lon, source = 'GPS') {
    digitalSignature.gpsLat = lat;
    digitalSignature.gpsLon = lon;
    digitalSignature.captureTimestamp = new Date().toISOString();
    gpsAcquired = true;

    // Fill coords immediately, then upgrade to address
    locationField.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    showGpsStatus(`✅ ${source} location acquired — fetching address…`);

    const address = await reverseGeocode(lat, lon);
    if (address) locationField.value = address;

    showGpsStatus(`✅ Location ready (${source}): ${lat.toFixed(4)}°, ${lon.toFixed(4)}°`);
    gpsBtn.disabled = false;
    gpsBtn.querySelector('span:last-child').textContent = '✅ GPS';
    gpsBtn.style.borderColor = 'var(--clr-accent)';
    checkFormValidity();
}

/** Fallback: get location via IP geolocation (works even if GPS is denied) */
async function acquireViaIP(silent) {
    if (!silent) showGpsStatus('📡 Trying IP-based location…');

    // Try multiple free IP geolocation APIs in order
    const providers = [
        async () => {
            const r = await fetch('https://ipwho.is/');
            const d = await r.json();
            if (!d.success || !d.latitude) throw new Error('ipwho.is failed');
            return { lat: d.latitude, lon: d.longitude };
        },
        async () => {
            const r = await fetch('https://ip-api.com/json/?fields=lat,lon,status');
            const d = await r.json();
            if (d.status !== 'success' || !d.lat) throw new Error('ip-api.com failed');
            return { lat: d.lat, lon: d.lon };
        },
        async () => {
            const r = await fetch('https://ipapi.co/json/');
            const d = await r.json();
            if (!d.latitude || !d.longitude) throw new Error('ipapi.co failed');
            return { lat: d.latitude, lon: d.longitude };
        },
    ];

    for (const provider of providers) {
        try {
            const { lat, lon } = await provider();
            await applyLocation(lat, lon, 'IP');
            return;
        } catch { /* try next */ }
    }

    // All providers failed
    showGpsStatus('⚠️ Could not get location. Please type it manually.', 'error');
    gpsBtn.disabled = false;
    gpsBtn.querySelector('span:last-child').textContent = 'GPS';
    checkFormValidity();
}

function acquireGPS(silent = false) {
    gpsBtn.disabled = true;
    gpsBtn.querySelector('span:last-child').textContent = 'Locating…';
    if (!silent) showGpsStatus('📡 Acquiring location…');

    if (!navigator.geolocation) {
        acquireViaIP(silent);
        return;
    }

    function onBrowserSuccess(pos) {
        applyLocation(pos.coords.latitude, pos.coords.longitude, 'GPS');
    }

    function onNetworkSuccess(pos) {
        applyLocation(pos.coords.latitude, pos.coords.longitude, 'Network');
    }

    // Attempt 1: High-accuracy GPS
    navigator.geolocation.getCurrentPosition(
        onBrowserSuccess,
        (err) => {
            // Attempt 2: Network-based (Wi-Fi / cell)
            if (err.code === 3 || err.code === 2) {
                if (!silent) showGpsStatus('📡 Trying network location…');
                navigator.geolocation.getCurrentPosition(
                    onNetworkSuccess,
                    () => acquireViaIP(silent),   // Attempt 3: IP fallback
                    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
                );
            } else if (err.code === 1) {
                // Permission denied → go straight to IP
                if (!silent) showGpsStatus('📍 GPS denied — trying IP location…');
                acquireViaIP(silent);
            } else {
                acquireViaIP(silent);
            }
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
}


gpsBtn.addEventListener('click', () => acquireGPS(false));

// Auto-acquire location on page load (tries GPS → network → IP fallback)
acquireGPS(true);

function showGpsStatus(msg, type = 'ok') {
    gpsStatus.textContent = msg;
    gpsStatus.style.color = type === 'error' ? 'var(--clr-warn)' : 'var(--clr-accent)';
    gpsStatus.hidden = false;
}

/* ════════════════════════════════════════════
   5. Image Drop Zone & File Picker
   ════════════════════════════════════════════ */
dropZone.addEventListener('click', () => photoInput.click());
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') photoInput.click(); });
photoInput.addEventListener('change', () => {
    if (photoInput.files[0]) handleImageFile(photoInput.files[0]);
});

// Drag & drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0];
    if (file?.type.startsWith('image/')) handleImageFile(file);
});

// Remove photo
removePhotoBtn.addEventListener('click', resetPhotoState);

function resetPhotoState() {
    compressedBlob = null;
    digitalSignature = {};
    photoInput.value = '';
    previewContainer.hidden = true;
    signatureCard.hidden = true;
    compressionPanel.hidden = true;
    checkFormValidity();

    // Terminate any running worker
    if (imageWorker) { imageWorker.terminate(); imageWorker = null; }
}

/* ════════════════════════════════════════════
   6. Web Worker — Image Processing Pipeline
   ════════════════════════════════════════════ */
function handleImageFile(file) {
    if (!file.type.startsWith('image/')) return;

    // Show preview immediately
    const previewUrl = URL.createObjectURL(file);
    photoPreview.src = previewUrl;
    photoPreview.onload = () => URL.revokeObjectURL(previewUrl);
    previewContainer.hidden = false;

    // Reset previous state
    compressedBlob = null;
    compressionPanel.hidden = false;
    compressionStats.hidden = true;
    setProgress(0);
    checkFormValidity();

    console.log(`[App] Starting Web Worker for image: ${file.name} (${formatBytes(file.size)})`);

    // Terminate stale worker if any
    if (imageWorker) imageWorker.terminate();

    imageWorker = new Worker('/image-worker.js');

    imageWorker.onmessage = (evt) => {
        const msg = evt.data;

        if (msg.type === 'progress') {
            setProgress(msg.pct);
        }

        if (msg.type === 'done') {
            compressedBlob = msg.blob;
            digitalSignature = {
                gpsLat: msg.gpsLat,
                gpsLon: msg.gpsLon,
                captureTimestamp: msg.captureTimestamp,
            };

            // Update UI
            setProgress(100);
            showCompressionStats(msg.originalSize, msg.compressedSize);
            showDigitalSignature(digitalSignature);
            checkFormValidity();

            console.log(
                `[App] Worker done — Original: ${formatBytes(msg.originalSize)} → ` +
                `Compressed: ${formatBytes(msg.compressedSize)} ` +
                `(${Math.round((1 - msg.compressedSize / msg.originalSize) * 100)}% savings)`
            );

            // Update preview with compressed blob
            const compressedUrl = URL.createObjectURL(msg.blob);
            photoPreview.src = compressedUrl;
            photoPreview.onload = () => URL.revokeObjectURL(compressedUrl);

            imageWorker = null;
        }

        if (msg.type === 'error') {
            console.error('[App] Worker error:', msg.message);
            compressionPanel.hidden = true;
            // Still allow form submission with original file if worker fails
            compressedBlob = file;
            checkFormValidity();
        }
    };

    imageWorker.onerror = (err) => {
        console.error('[App] Worker uncaught error:', err.message);
        compressionPanel.hidden = true;
        compressedBlob = file;
        checkFormValidity();
    };

    imageWorker.postMessage({ imageFile: file });
}

function setProgress(pct) {
    progressBar.style.width = `${pct}%`;
    compressionPct.textContent = `${pct}%`;
}

function showCompressionStats(orig, comp) {
    statOriginal.textContent = formatBytes(orig);
    statCompressed.textContent = formatBytes(comp);
    const savings = Math.round((1 - comp / orig) * 100);
    statSavings.textContent = `${savings}% saved`;
    compressionStats.hidden = false;
}

function showDigitalSignature({ gpsLat, gpsLon, captureTimestamp }) {
    sigTimestamp.textContent = captureTimestamp
        ? new Date(captureTimestamp).toLocaleString()
        : 'Not available (no EXIF)';

    sigLat.textContent = gpsLat != null ? `${gpsLat}°` : 'Not available';
    sigLon.textContent = gpsLon != null ? `${gpsLon}°` : 'Not available';

    signatureCard.hidden = false;
}

/* ════════════════════════════════════════════
   7. Form Validation
   ════════════════════════════════════════════ */
function checkFormValidity() {
    const hasCategory = categoryField.value !== '';
    const hasDescription = descField.value.trim().length > 0;
    const hasPhoto = compressedBlob !== null;
    // GPS is mandatory — either from button or EXIF
    const hasGPS = gpsAcquired ||
        (digitalSignature.gpsLat != null && digitalSignature.gpsLon != null);

    submitBtn.disabled = !(hasCategory && hasDescription && hasPhoto && hasGPS);

    // Show hint if GPS missing
    if (!hasGPS && (hasCategory || hasDescription)) {
        gpsStatus.hidden = false;
        if (!gpsStatus.textContent.startsWith('✅')) {
            gpsStatus.textContent = '📍 GPS required — click the GPS button above';
            gpsStatus.style.color = 'var(--clr-warn)';
        }
    }
}

[categoryField, descField, locationField].forEach((el) =>
    el.addEventListener('input', checkFormValidity)
);

/* ════════════════════════════════════════════
   8. Form Submission
   ════════════════════════════════════════════ */
reportForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();

    const reportData = {
        category: categoryField.value,
        description: descField.value.trim(),
        location: locationField.value.trim(),
        location_detail: locationDetailField.value.trim() || null,
        // GPS from button click OR from EXIF
        gpsLat: digitalSignature.gpsLat ?? null,
        gpsLon: digitalSignature.gpsLon ?? null,
        captureTimestamp: digitalSignature.captureTimestamp ?? new Date().toISOString(),
        severity_level: document.getElementById('severity-select')?.value || 'medium',
        reporter_token: reporterToken,
        submittedAt: new Date().toISOString(),
    };

    submitBtn.disabled = true;
    submitLabel.textContent = 'Submitting…';

    // Always try online first — navigator.onLine is unreliable for localhost
    // Only fall back to offline queue if the network request actually fails
    await submitOnline(reportData);
}, false);

async function submitOnline(reportData) {
    try {
        const formData = buildFormDataFromReport(reportData, compressedBlob);
        const response = await fetch('/api/reports', { method: 'POST', body: formData });

        if (response.ok) {
            const data = await response.json();
            showToast(data.isDuplicate
                ? `🤝 Merged! ${data.supporterCount} neighbors support this report`
                : `✅ Report #${data.reportId} submitted!`);
            showResponseCard(data);

            // Phase 5: Store in sessionStorage so dashboard "My Reports" can show it
            storeMyReport(data, reportData);

            if (!data.isDuplicate) {
                subscribeToPush(data.reportId).catch(() => { });
            }
            resetFormAfterSubmit();

            // Show a "View on Dashboard" link
            const viewLink = document.getElementById('view-dashboard-link');
            if (viewLink) {
                viewLink.href = `/dashboard.html`;
                viewLink.hidden = false;
            }
        } else {
            // Show the actual server error — do NOT silently queue
            let errMsg = `Server error ${response.status}`;
            try {
                const errData = await response.json();
                errMsg = errData.error || errMsg;
            } catch { }
            showToast(`❌ ${errMsg}`, 5000);
            submitBtn.disabled = false;
            submitLabel.textContent = 'Submit Report';
        }
    } catch (err) {
        // True network error — retry once after 1s before queuing
        console.warn('[App] Network error, retrying once…', err.message);
        try {
            await new Promise(r => setTimeout(r, 1000));
            const formData = buildFormDataFromReport(reportData, compressedBlob);
            const retryRes = await fetch('/api/reports', { method: 'POST', body: formData });
            if (retryRes.ok) {
                const data = await retryRes.json();
                showToast(data.isDuplicate
                    ? `🤝 Merged! ${data.supporterCount} neighbors support this report`
                    : `✅ Report #${data.reportId} submitted!`);
                showResponseCard(data);
                storeMyReport(data, reportData);
                resetFormAfterSubmit();
                return;
            }
        } catch { }
        // Both attempts failed — fall back to offline queue
        console.warn('[App] Retry failed, queuing report offline');
        await submitOffline(reportData);
    }
}

function storeMyReport(data, reportData) {
    try {
        const myReports = JSON.parse(localStorage.getItem('civicpulse-my-reports') || '[]');
        myReports.unshift({
            reportId: data.reportId,
            category: reportData.category,
            description: reportData.description,
            location: reportData.location,
            gpsLat: reportData.gpsLat,
            gpsLon: reportData.gpsLon,
            severity_level: reportData.severity_level,
            isDuplicate: data.isDuplicate,
            ward: data.ward,
            submittedAt: new Date().toISOString(),
        });
        // Keep last 50
        if (myReports.length > 50) myReports.pop();
        localStorage.setItem('civicpulse-my-reports', JSON.stringify(myReports));
    } catch { }
}

async function submitOffline(reportData) {
    // Convert blob to base64 for IndexedDB storage (Blobs aren't reliably persisted)
    const imageBase64 = compressedBlob ? await blobToBase64(compressedBlob) : null;

    await saveReport({ ...reportData, imageBase64 });

    // Register background sync
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.ready;
            if ('sync' in reg) {
                await reg.sync.register('sync-reports');
                console.log('[App] Background Sync registered for queued report');
            }
        } catch (err) {
            console.warn('[App] Background Sync registration failed:', err);
        }
    }

    showToast('📦 Report saved — will sync when you\'re back online');
    refreshQueueDisplay();
    resetFormAfterSubmit();
}

function buildFormDataFromReport(reportData, blob) {
    const fd = new FormData();
    Object.entries(reportData).forEach(([k, v]) => { if (v !== null) fd.append(k, v); });
    if (blob) fd.append('photo', blob, 'report.jpg');
    return fd;
}

function resetFormAfterSubmit() {
    reportForm.reset();
    charCount.textContent = '0';
    resetPhotoState();
    gpsStatus.hidden = true;
    submitBtn.disabled = true;
    submitLabel.textContent = navigator.onLine ? 'Submit Report' : 'Save for Later (Offline)';
}

/* ════════════════════════════════════════════
   8b. Spatial Response Card (Phase 2)
   ════════════════════════════════════════════ */
function showResponseCard(data) {
    responseCard.hidden = false;
    responseId.textContent = `#${data.reportId}`;
    responseMsg.textContent = data.message || '—';

    if (data.ward) {
        responseIcon.textContent = '🗺️';
        responseTitle.textContent = data.isDuplicate ? 'Report Merged' : 'Report Routed';
        responseWard.textContent = data.ward.wardName;
        responseZone.textContent = data.ward.zone || '—';
        responseOfficer.textContent = `${data.ward.officerName} (${data.ward.officerEmail})`;
        responseWardRow.hidden = false;
        responseZoneRow.hidden = false;
        responseOfficerRow.hidden = false;
    } else {
        responseIcon.textContent = '📋';
        responseTitle.textContent = 'Report Submitted';
        responseWardRow.hidden = true;
        responseZoneRow.hidden = true;
        responseOfficerRow.hidden = true;
    }

    if (data.isDuplicate) {
        mergeBanner.hidden = false;
        mergeMsg.textContent = `Another neighbor already reported this! ${data.supporterCount} people now support this report.`;
        responseSupportRow.hidden = false;
        responseSupporters.textContent = `${data.supporterCount} citizen${data.supporterCount !== 1 ? 's' : ''}`;
    } else {
        mergeBanner.hidden = true;
        responseSupportRow.hidden = true;
    }

    // Scroll response card into view
    responseCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ════════════════════════════════════════════
   8c. Push Notification Subscription
   ════════════════════════════════════════════ */

/**
 * urlBase64ToUint8Array — Helper to convert VAPID public key
 * from base64url string to Uint8Array (required by pushManager.subscribe)
 */
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/**
 * subscribeToPush(reportId)
 * 1. Requests notification permission
 * 2. Creates a PushSubscription via pushManager.subscribe()
 * 3. POSTs the subscription + reportId to /api/push/subscribe
 */
async function subscribeToPush(reportId = null) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('[Push] Push notifications not supported');
        return;
    }

    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        console.warn('[Push] Notification permission denied');
        updateNotifButton('denied');
        return;
    }

    try {
        // Get VAPID public key from server
        const keyRes = await fetch('/api/push/vapid-public-key');
        const { publicKey } = await keyRes.json();

        // Get service worker registration
        const reg = await navigator.serviceWorker.ready;

        // Create Push subscription
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        // POST to server
        const subJson = subscription.toJSON();
        const saveRes = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                endpoint: subJson.endpoint,
                keys: subJson.keys,
                reportId,
            }),
        });

        if (saveRes.ok) {
            console.log(`[Push] Subscribed for push notifications on report #${reportId}`);
            updateNotifButton('granted');
            localStorage.setItem('civicpulse-push', 'granted');
            showToast('🔔 Notifications enabled — we\'ll alert you when neighbors support your report!');
        }
    } catch (err) {
        console.error('[Push] subscribeToPush error:', err);
    }
}

/**
 * Update the notification bell button appearance
 */
function updateNotifButton(state) {
    if (!notifBtn || !notifBtnLabel) return;
    if (state === 'granted') {
        notifBtn.classList.add('notif-active');
        notifBtnLabel.textContent = 'Alerts On';
        notifBtn.title = 'Push notifications enabled';
    } else if (state === 'denied') {
        notifBtn.classList.add('notif-denied');
        notifBtnLabel.textContent = 'Blocked';
        notifBtn.title = 'Notifications blocked — enable in browser settings';
    } else {
        notifBtn.classList.remove('notif-active', 'notif-denied');
        notifBtnLabel.textContent = 'Alerts';
        notifBtn.title = 'Enable push notifications';
    }
}

// Bell button click handler
if (notifBtn) {
    notifBtn.addEventListener('click', () => {
        if (Notification.permission === 'granted') {
            showToast('🔔 Already subscribed! You\'ll get alerts for your reports.');
        } else {
            subscribeToPush(null);
        }
    });
}

async function refreshQueueDisplay() {
    const reports = await getPendingReports();

    if (reports.length === 0) {
        queueCard.hidden = true;
        return;
    }

    queueCard.hidden = false;
    queueCountBadge.textContent = reports.length;
    queueList.innerHTML = '';

    reports.forEach((r) => {
        const item = document.createElement('li');
        item.className = 'queue-item';
        item.innerHTML = `
      <span class="queue-item-icon">📋</span>
      <span class="queue-item-cat">${escapeHtml(r.category || 'Unknown')}</span>
      <span class="queue-item-time">${new Date(r.createdAt).toLocaleTimeString()}</span>
    `;
        queueList.appendChild(item);
    });
}

/* ════════════════════════════════════════════
   9b. Flush Offline Queue (immediate upload)
   ════════════════════════════════════════════ */
async function flushOfflineQueue() {
    if (!navigator.onLine) return;
    const reports = await getPendingReports();
    if (!reports.length) return;

    console.log(`[App] Flushing ${reports.length} queued report(s)…`);
    let flushed = 0;

    for (const report of reports) {
        try {
            const fd = new FormData();
            ['category', 'description', 'location', 'location_detail', 'gpsLat', 'gpsLon',
                'captureTimestamp', 'severity_level', 'reporter_token'].forEach(k => {
                    if (report[k] != null) fd.append(k, report[k]);
                });
            if (report.imageBase64) {
                const byteStr = atob(report.imageBase64);
                const bytes = new Uint8Array(byteStr.length);
                for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
                fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'report.jpg');
            }

            const res = await fetch('/api/reports', { method: 'POST', body: fd });
            if (res.ok) {
                const data = await res.json();
                await deleteReport(report.id);
                flushed++;
                storeMyReport(data, report);
                console.log(`[App] Flushed queued report id=${report.id} → server #${data.reportId}`);
            }
        } catch (err) {
            console.warn(`[App] Could not flush report id=${report.id}:`, err.message);
        }
    }

    if (flushed > 0) {
        showToast(`✅ ${flushed} queued report${flushed !== 1 ? 's' : ''} uploaded!`);
    }
    refreshQueueDisplay();
}

/* ════════════════════════════════════════════
   10. Toast
   ════════════════════════════════════════════ */
let toastTimer = null;
function showToast(message, duration = 3500) {
    syncToastMsg.textContent = message;
    syncToast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { syncToast.hidden = true; }, duration);
}

/* ════════════════════════════════════════════
   Utilities
   ════════════════════════════════════════════ */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]); // strip data: prefix
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ════════════════════════════════════════════
   Init
   ════════════════════════════════════════════ */
(async function init() {
    updateOnlineStatus();
    await registerServiceWorker();
    await refreshQueueDisplay();

    // Immediately flush any queued reports if we're online
    await flushOfflineQueue();

    // Restore notification button state from previous session
    const savedPush = localStorage.getItem('civicpulse-push');
    if (savedPush === 'granted' && Notification.permission === 'granted') {
        updateNotifButton('granted');
    } else if (Notification.permission === 'denied') {
        updateNotifButton('denied');
    }

    console.log('[App] CivicPulse Phase 2 initialized 🏛️');
})();
