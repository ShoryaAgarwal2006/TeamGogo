/**
 * dashboard.js — CivicPulse Accountability Dashboard
 *
 * Features:
 *  • Fetches /api/dashboard and renders report cards
 *  • Live per-card SLA countdown timers (updates every second)
 *  • SLA-level colour rings: green → amber → orange flash → red flash
 *  • Officer "In Progress" geo-fence check before PATCH /transition
 *  • State badge chips matching the state machine
 *  • Auto-refresh every 30 seconds
 *  • Filter pills by state
 */

/* ── State ─────────────────────────────────────────────────── */
let allReports = [];
let activeFilter = 'all';
let timerInterval = null;
let refreshTimer = null;
let pendingTransition = null; // { reportId, toState, officerLat?, officerLon? }

/* ── DOM refs ──────────────────────────────────────────────── */
const grid = document.getElementById('dash-grid');
const loadingEl = document.getElementById('dash-loading');
const emptyEl = document.getElementById('dash-empty');
const lastUpdated = document.getElementById('last-updated');
const onlineDot = document.getElementById('online-dot');
const offlineBanner = document.getElementById('offline-banner');
const toast = document.getElementById('dash-toast');
const toastMsg = document.getElementById('dash-toast-msg');

// Summary stats
const sTotal = document.getElementById('s-total');
const sTrack = document.getElementById('s-track');
const sWarn = document.getElementById('s-warn');
const sUrgent = document.getElementById('s-urgent');
const sCrit = document.getElementById('s-crit');

// Modal
const modal = document.getElementById('transition-modal');
const modalIcon = document.getElementById('modal-icon');
const modalTitle = document.getElementById('modal-title');
const modalSub = document.getElementById('modal-sub');
const modalConfirm = document.getElementById('modal-confirm');
const modalConfirmLabel = document.getElementById('modal-confirm-label');
const modalCancel = document.getElementById('modal-cancel');
const modalClose = document.getElementById('modal-close');
const modalGeoWarn = document.getElementById('modal-geo-warning');
const modalGeoErr = document.getElementById('modal-geo-error');
const modalGeoErrMsg = document.getElementById('modal-geo-error-msg');

/* ── Config ────────────────────────────────────────────────── */
const STATE_META = {
    SUBMITTED: { label: 'Submitted', emoji: '📋', cls: 'state-submitted', color: '#64748b' },
    VERIFIED: { label: 'Verified', emoji: '✅', cls: 'state-verified', color: '#22d3ee' },
    ASSIGNED: { label: 'Assigned', emoji: '👷', cls: 'state-assigned', color: '#a78bfa' },
    IN_PROGRESS: { label: 'In Progress', emoji: '🔧', cls: 'state-in-progress', color: '#f59e0b' },
    RESOLVED: { label: 'Resolved', emoji: '🎉', cls: 'state-resolved', color: '#10b981' },
    MERGED: { label: 'Merged', emoji: '🤝', cls: 'state-merged', color: '#475569' },
};

const NEXT_STATE = {
    SUBMITTED: 'VERIFIED',
    VERIFIED: 'ASSIGNED',
    ASSIGNED: 'IN_PROGRESS',
    IN_PROGRESS: 'RESOLVED',
};

const NEXT_STATE_LABELS = {
    VERIFIED: { label: 'Mark Verified', icon: '✅' },
    ASSIGNED: { label: 'Assign to Officer', icon: '👷' },
    IN_PROGRESS: { label: 'Mark In Progress', icon: '🔧' },
    RESOLVED: { label: 'Mark Resolved', icon: '🎉' },
};

const SLA_STATUS_META = {
    ON_TRACK: { cls: 'sla-ok', ring: '#10b981', label: 'On Track' },
    WATCH: { cls: 'sla-watch', ring: '#22d3ee', label: 'Watch' },
    WARNING: { cls: 'sla-warning', ring: '#f59e0b', label: 'L1 — 72h breach', flash: false },
    URGENT: { cls: 'sla-urgent', ring: '#ef4444', label: 'L2 — Urgent!', flash: true },
    CRITICAL: { cls: 'sla-critical', ring: '#7c3aed', label: 'L3 — Critical!', flash: true },
};

const CATEGORY_ICONS = {
    pothole: '🕳️', streetlight: '💡', garbage: '🗑️',
    graffiti: '🎨', flooding: '🌊', sidewalk: '🚶', other: '📋',
};

/* ══════════════════════════════════════════════════════════════
   DATA FETCH
   ══════════════════════════════════════════════════════════════ */
async function fetchDashboard() {
    try {
        const res = await fetch('/api/dashboard?limit=200');
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const { reports, summary } = await res.json();
        allReports = reports;
        updateSummary(summary);
        renderGrid();
        lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
        console.error('[Dashboard] Fetch error:', err.message);
        showToast('⚠️ Could not load reports — ' + err.message, 4000);
    }
}

function updateSummary(s) {
    if (!s) return;
    sTotal.textContent = s.total ?? '—';
    sTrack.textContent = (s.on_track ?? 0);
    sWarn.textContent = (s.warning ?? 0);
    sUrgent.textContent = (s.urgent ?? 0);
    sCrit.textContent = (s.critical ?? 0);
}

/* ══════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════ */
function renderGrid() {
    // Clear old timers
    if (timerInterval) clearInterval(timerInterval);

    const filtered = activeFilter === 'all'
        ? allReports
        : allReports.filter(r => r.state === activeFilter);

    loadingEl.hidden = true;

    if (!filtered.length) {
        grid.innerHTML = '';
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;

    grid.innerHTML = filtered.map(r => buildCard(r)).join('');

    // Attach transition button listeners
    filtered.forEach(r => {
        const btn = document.getElementById(`btn-transition-${r.id}`);
        if (btn) btn.addEventListener('click', () => openTransitionModal(r));
    });

    // Start live countdown timers
    timerInterval = setInterval(() => updateTimers(filtered), 1000);
}

function buildCard(r) {
    const sm = STATE_META[r.state] || STATE_META.SUBMITTED;
    const slaMeta = SLA_STATUS_META[r.sla_status] || SLA_STATUS_META.ON_TRACK;
    const catIcon = CATEGORY_ICONS[r.category] || '📋';
    const nextState = NEXT_STATE[r.state];
    const nextLabel = nextState ? NEXT_STATE_LABELS[nextState] : null;

    const cardClass = [
        'report-card glass-card',
        slaMeta.cls,
        slaMeta.flash ? 'sla-flash' : '',
    ].join(' ');

    const hoursDisplay = r.assigned_at
        ? `${r.hours_elapsed}h elapsed`
        : r.state === 'SUBMITTED'
            ? `${Math.floor((Date.now() - new Date(r.created_at).getTime()) / 3_600_000)}h old`
            : '—';

    const slaRingColor = slaMeta.ring;

    return `
<div class="${cardClass}" id="card-${r.id}">
  <!-- SLA Ring indicator -->
  <div class="sla-ring-wrap">
    <svg class="sla-ring" viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="20" class="sla-ring-bg"/>
      <circle cx="24" cy="24" r="20" class="sla-ring-fg"
        style="stroke:${slaRingColor};stroke-dasharray:${calcDashArray(r)}"
        transform="rotate(-90 24 24)"/>
    </svg>
    <span class="sla-ring-icon">${catIcon}</span>
  </div>

  <!-- Card header -->
  <div class="card-header">
    <div class="card-id-row">
      <span class="card-id">#${r.id}</span>
      <span class="state-badge ${sm.cls}">${sm.emoji} ${sm.label}</span>
    </div>
    <span class="card-category">${catIcon} ${capitalize(r.category)}</span>
  </div>

  <!-- SLA status bar -->
  <div class="sla-bar-wrap">
    <div class="sla-bar ${slaMeta.cls}">
      <span class="sla-bar-dot"></span>
      <span class="sla-bar-label">${slaMeta.label}</span>
      <span class="sla-timer" id="timer-${r.id}">${hoursDisplay}</span>
    </div>
  </div>

  <!-- Info rows -->
  <div class="card-fields">
    ${r.ward_name ? `<div class="card-field"><span class="cf-key">🗺️ Ward</span><span class="cf-val">${r.ward_name}</span></div>` : ''}
    ${r.officer_name ? `<div class="card-field"><span class="cf-key">👤 Officer</span><span class="cf-val">${r.officer_name}</span></div>` : ''}
    <div class="card-field">
      <span class="cf-key">👥 Support</span>
      <span class="cf-val">${r.supporter_count} citizen${r.supporter_count !== 1 ? 's' : ''}</span>
    </div>
    ${r.location_text ? `<div class="card-field"><span class="cf-key">📍 Location</span><span class="cf-val loc">${escHtml(r.location_text)}</span></div>` : ''}
  </div>

  <!-- Description -->
  <p class="card-desc">${escHtml((r.description || '').slice(0, 120))}${r.description?.length > 120 ? '…' : ''}</p>

  <!-- Action button -->
  ${nextLabel ? `
  <button id="btn-transition-${r.id}" class="btn btn-transition" 
          data-report-id="${r.id}" data-to-state="${nextState}">
    ${nextLabel.icon} ${nextLabel.label}
  </button>` : `<div class="card-resolved-tag">${sm.emoji} ${sm.label}</div>`}

  ${r.sla_level >= 3 ? '<div class="escalation-badge">🚨 Commissioner notified</div>' : ''}
  ${r.sla_level === 2 ? '<div class="escalation-badge urgent">🔴 Executive Engineer alerted</div>' : ''}
  ${r.sla_level === 1 ? '<div class="escalation-badge warn">⚠️ Junior Engineer notified</div>' : ''}
</div>`;
}

function calcDashArray(r) {
    const circumference = 2 * Math.PI * 20; // ~125.66
    const maxHours = 168;
    const elapsed = Math.min(r.hours_elapsed || 0, maxHours);
    const pct = elapsed / maxHours;
    const filled = circumference * pct;
    return `${filled.toFixed(1)} ${circumference.toFixed(1)}`;
}

function updateTimers(reports) {
    reports.forEach(r => {
        const el = document.getElementById(`timer-${r.id}`);
        if (!el) return;
        if (r.assigned_at) {
            const hoursElapsed = (Date.now() - new Date(r.assigned_at).getTime()) / 3_600_000;
            el.textContent = `${hoursElapsed.toFixed(1)}h elapsed`;
        } else if (r.state === 'SUBMITTED') {
            const hoursOld = (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
            el.textContent = `${hoursOld.toFixed(1)}h old`;
        }
    });
}

/* ══════════════════════════════════════════════════════════════
   TRANSITION MODAL
   ══════════════════════════════════════════════════════════════ */
function openTransitionModal(report) {
    const toState = NEXT_STATE[report.state];
    if (!toState) return;

    const lbl = NEXT_STATE_LABELS[toState];
    pendingTransition = { reportId: report.id, toState, report };

    modalIcon.textContent = lbl.icon;
    modalTitle.textContent = lbl.label;
    modalSub.textContent = `Report #${report.id} — ${capitalize(report.category)} in ${report.ward_name || report.location_text || 'Unknown Ward'}`;
    modalGeoWarn.hidden = true;
    modalGeoErr.hidden = true;
    modalConfirm.disabled = false;
    modalConfirmLabel.textContent = lbl.label;

    modal.hidden = false;

    // For IN_PROGRESS: require GPS — grab it immediately
    if (toState === 'IN_PROGRESS') {
        modalConfirm.disabled = true;
        modalGeoWarn.hidden = false;
        acquireOfficerGPS();
    }
}

function acquireOfficerGPS() {
    if (!navigator.geolocation) {
        modalGeoErr.hidden = false;
        modalGeoErrMsg.textContent = 'Geolocation not supported. Cannot verify on-site presence.';
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            pendingTransition.officerLat = pos.coords.latitude;
            pendingTransition.officerLon = pos.coords.longitude;
            modalGeoWarn.hidden = true;
            modalGeoErr.hidden = true;
            modalConfirm.disabled = false;
            modalConfirmLabel.textContent = `✅ Confirm — GPS verified (${pos.coords.latitude.toFixed(4)}°, ${pos.coords.longitude.toFixed(4)}°)`;
        },
        (err) => {
            modalGeoErr.hidden = false;
            modalGeoErrMsg.textContent = `GPS error: ${err.message}. Cannot verify on-site presence.`;
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

async function confirmTransition() {
    if (!pendingTransition) return;
    const { reportId, toState, officerLat, officerLon } = pendingTransition;

    modalConfirm.disabled = true;
    modalConfirmLabel.textContent = 'Applying…';

    try {
        const body = { toState };
        if (officerLat != null) body.officerLat = officerLat;
        if (officerLon != null) body.officerLon = officerLon;

        const res = await fetch(`/api/reports/${reportId}/transition`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        const data = await res.json();

        if (res.ok) {
            showToast(`${data.message}`, 4000);
            closeModal();
            await fetchDashboard(); // Refresh
        } else {
            let errMsg = data.error;
            if (data.distanceMetres) errMsg += ` (${data.distanceMetres}m from issue)`;
            modalGeoErr.hidden = false;
            modalGeoErrMsg.textContent = errMsg;
            modalConfirm.disabled = false;
            modalConfirmLabel.textContent = 'Retry';
        }
    } catch (err) {
        modalGeoErr.hidden = false;
        modalGeoErrMsg.textContent = 'Network error: ' + err.message;
        modalConfirm.disabled = false;
    }
}

function closeModal() {
    modal.hidden = true;
    pendingTransition = null;
}

/* ══════════════════════════════════════════════════════════════
   FILTER PILLS
   ══════════════════════════════════════════════════════════════ */
document.querySelectorAll('.fpill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.fpill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        renderGrid();
    });
});

/* ══════════════════════════════════════════════════════════════
   AUTO-REFRESH
   ══════════════════════════════════════════════════════════════ */
document.getElementById('refresh-btn').addEventListener('click', () => {
    fetchDashboard();
    resetAutoRefresh();
});

function resetAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(fetchDashboard, 30_000);
}

/* ══════════════════════════════════════════════════════════════
   MODAL EVENTS
   ══════════════════════════════════════════════════════════════ */
modalConfirm.addEventListener('click', confirmTransition);
modalCancel.addEventListener('click', closeModal);
modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

/* ══════════════════════════════════════════════════════════════
   ONLINE / OFFLINE
   ══════════════════════════════════════════════════════════════ */
function updateOnlineStatus() {
    const online = navigator.onLine;
    offlineBanner.hidden = online;
    onlineDot.classList.toggle('offline', !online);
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

/* ══════════════════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════════════════ */
let toastTimer = null;
function showToast(msg, duration = 3500) {
    toastMsg.textContent = msg;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

/* ══════════════════════════════════════════════════════════════
   UTILS
   ══════════════════════════════════════════════════════════════ */
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
(async function init() {
    updateOnlineStatus();
    await fetchDashboard();
    resetAutoRefresh();
    console.log('[Dashboard] CivicPulse Phase 3 Accountability Dashboard initialized 🏛️');
})();
