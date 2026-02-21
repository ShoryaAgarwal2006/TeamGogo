/**
 * dashboard.js — CivicPulse Accountability Dashboard (Phase 5)
 *
 * Features:
 *  • SSE live feed (replaces 30s polling)
 *  • Leaflet map with color-coded report pins
 *  • Emergency alert banner
 *  • Issue detail modal: Action / Timeline / Chat tabs
 *  • Ward performance table
 *  • Nearby complaints (user GPS radius)
 *  • Severity filter + state filter
 */

/* ── State ─────────────────────────────────────────────────── */
let allReports = [];
let activeFilter = 'all';
let activeSevFilter = 'all';
let timerInterval = null;
let pendingTransition = null;
let dashMap = null;
let mapMarkers = {};
let activeReportId = null;
let userLat = null, userLon = null;
let nearbyRadius = 500;
let sseConn = null;

// Reporter token for My Reports
const reporterToken = localStorage.getItem('civicpulse-reporter-token') || null;

/* ── DOM refs ──────────────────────────────────────────────── */
const grid = document.getElementById('dash-grid');
const loadingEl = document.getElementById('dash-loading');
const emptyEl = document.getElementById('dash-empty');
const lastUpdated = document.getElementById('last-updated');
const onlineDot = document.getElementById('online-dot');
const offlineBanner = document.getElementById('offline-banner');
const toast = document.getElementById('dash-toast');
const toastMsg = document.getElementById('dash-toast-msg');
const sseDot = document.getElementById('sse-dot');

// Summary
const sTotal = document.getElementById('s-total');
const sTrack = document.getElementById('s-track');
const sWarn = document.getElementById('s-warn');
const sUrgent = document.getElementById('s-urgent');
const sCrit = document.getElementById('s-crit');
const sEmerg = document.getElementById('s-emerg');

// Emergency banner
const emergencyBanner = document.getElementById('emergency-banner');
const emergencyList = document.getElementById('emergency-list');
const emergencyDismiss = document.getElementById('emergency-dismiss');

// Issue modal
const issueModal = document.getElementById('issue-modal');
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

const SEV_META = {
    critical: { color: '#dc2626', icon: '🔥', ringColor: '#dc2626' },
    high: { color: '#ef4444', icon: '🔴', ringColor: '#ef4444' },
    medium: { color: '#f59e0b', icon: '🟡', ringColor: '#f59e0b' },
    low: { color: '#10b981', icon: '🟢', ringColor: '#10b981' },
};

const NEXT_STATE = {
    SUBMITTED: 'VERIFIED', VERIFIED: 'ASSIGNED',
    ASSIGNED: 'IN_PROGRESS', IN_PROGRESS: 'RESOLVED',
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
    WARNING: { cls: 'sla-warning', ring: '#f59e0b', label: 'L1 — 72h breach' },
    URGENT: { cls: 'sla-urgent', ring: '#ef4444', label: 'L2 — Urgent!', flash: true },
    CRITICAL: { cls: 'sla-critical', ring: '#7c3aed', label: 'L3 — Critical!', flash: true },
};
const CAT_ICONS = {
    pothole: '🕳️', streetlight: '💡', garbage: '🗑️',
    graffiti: '🎨', flooding: '🌊', sidewalk: '🚶', other: '📋',
};

/* ══════════════════════════════════════════════════════════════
   SSE — Live Feed
   ══════════════════════════════════════════════════════════════ */
function connectSSE() {
    if (sseConn) sseConn.close();
    sseConn = new EventSource('/api/live-feed');

    sseConn.onopen = () => {
        sseDot.style.color = '#10b981';
        sseDot.title = 'Live feed connected';
    };

    sseConn.onmessage = (evt) => {
        try {
            const data = JSON.parse(evt.data);
            if (data.type === 'snapshot') {
                allReports = data.reports || [];
                renderGrid();
                updateSummaryFromReports();
                updateMapPins();
                lastUpdated.textContent = `Live — ${new Date().toLocaleTimeString()}`;
            } else if (data.type === 'chat' && data.reportId === activeReportId) {
                appendChatMessage(data.msg);
            } else if (data.type === 'transition' || data.type === 'verify') {
                fetchDashboard(); // re-fetch on state change
            }
        } catch { }
    };

    sseConn.onerror = () => {
        sseDot.style.color = '#ef4444';
        sseDot.title = 'Live feed disconnected — reconnecting…';
        // Browser auto-reconnects SSE
    };
}

/* ══════════════════════════════════════════════════════════════
   DATA FETCH (fallback manual)
   ══════════════════════════════════════════════════════════════ */
async function fetchDashboard() {
    try {
        const res = await fetch('/api/dashboard?limit=200');
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
        const { reports, summary } = await res.json();
        allReports = reports;
        updateSummary(summary);
        renderGrid();
        updateMapPins();
        lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
        console.error('[Dashboard] Fetch error:', err.message);
        loadingEl.querySelector('p').textContent = `⚠️ ${err.message}`;
        loadingEl.hidden = false;
        grid.innerHTML = '';
    }
}

async function fetchEmergencyAlerts() {
    try {
        const res = await fetch('/api/emergency-alerts');
        if (!res.ok) return;
        const { alerts } = await res.json();
        if (alerts && alerts.length > 0) {
            renderEmergencyBanner(alerts);
        }
    } catch { }
}

async function fetchWardPerformance() {
    try {
        const res = await fetch('/api/ward-performance');
        if (!res.ok) return;
        const { wards } = await res.json();
        renderWardTable(wards);
    } catch (err) {
        document.getElementById('ward-table-wrap').innerHTML = `<p style="color:#ef4444;padding:1rem">Could not load ward data: ${err.message}</p>`;
    }
}

/* ══════════════════════════════════════════════════════════════
   SUMMARY
   ══════════════════════════════════════════════════════════════ */
function updateSummary(s) {
    if (!s) return;
    sTotal.textContent = s.total ?? '—';
    sTrack.textContent = s.on_track ?? 0;
    sWarn.textContent = s.warning ?? 0;
    sUrgent.textContent = s.urgent ?? 0;
    sCrit.textContent = s.critical ?? 0;
    sEmerg.textContent = s.emergency ?? 0;
}

function updateSummaryFromReports() {
    const on_track = allReports.filter(r => (r.sla_level || 0) === 0).length;
    const warning = allReports.filter(r => (r.sla_level || 0) === 1).length;
    const urgent = allReports.filter(r => (r.sla_level || 0) === 2).length;
    const critical = allReports.filter(r => (r.sla_level || 0) >= 3).length;
    const emergency = allReports.filter(r => r.is_emergency).length;
    updateSummary({ total: allReports.length, on_track, warning, urgent, critical, emergency });
}

/* ══════════════════════════════════════════════════════════════
   EMERGENCY BANNER
   ══════════════════════════════════════════════════════════════ */
function renderEmergencyBanner(alerts) {
    emergencyBanner.hidden = false;
    emergencyList.innerHTML = alerts.map(a =>
        `<span class="emergency-item">🚨 <strong>${escHtml(a.category)}</strong> in ${escHtml(a.ward_name || 'Unknown')} — ${escHtml((a.description || '').slice(0, 60))}…</span>`
    ).join(' &nbsp;·&nbsp; ');
}
emergencyDismiss.addEventListener('click', () => { emergencyBanner.hidden = true; });

/* ══════════════════════════════════════════════════════════════
   MAP (Leaflet)
   ══════════════════════════════════════════════════════════════ */
function initMap() {
    dashMap = L.map('dash-map', { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 18,
    }).addTo(dashMap);
    dashMap.setView([28.62, 77.22], 12); // Default: Central Delhi
}

function severityToColor(sev) {
    return (SEV_META[sev] || SEV_META.medium).color;
}

function stateToMapColor(state) {
    const m = { SUBMITTED: '#64748b', VERIFIED: '#22d3ee', ASSIGNED: '#a78bfa', IN_PROGRESS: '#f59e0b', RESOLVED: '#10b981' };
    return m[state] || '#64748b';
}

function updateMapPins() {
    if (!dashMap) return;
    // Remove old markers not in current list
    const currentIds = new Set(allReports.map(r => r.id));
    Object.keys(mapMarkers).forEach(id => {
        if (!currentIds.has(parseInt(id))) {
            dashMap.removeLayer(mapMarkers[id]);
            delete mapMarkers[id];
        }
    });

    allReports.forEach(r => {
        if (!r.gps_lat || !r.gps_lon) return;
        const color = r.is_emergency ? '#dc2626' : stateToMapColor(r.state);
        const icon = L.divIcon({
            className: '',
            html: `<div style="background:${color};width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 ${r.is_emergency ? '8px #dc2626' : '4px rgba(0,0,0,.4)'}${r.is_emergency ? ',0 0 16px #dc262660' : ''}"></div>`,
            iconSize: [14, 14], iconAnchor: [7, 7],
        });
        if (mapMarkers[r.id]) {
            mapMarkers[r.id].setLatLng([r.gps_lat, r.gps_lon]);
            mapMarkers[r.id].setIcon(icon);
        } else {
            const m = L.marker([r.gps_lat, r.gps_lon], { icon });
            m.bindPopup(`
                <div style="min-width:200px">
                    <strong>#${r.id} — ${escHtml(r.category)}</strong><br>
                    <span style="color:${color}">● ${r.state}</span><br>
                    <small>${escHtml((r.description || '').slice(0, 80))}…</small><br>
                    <small>👥 ${r.supporter_count} supporters</small><br>
                    <button onclick="openIssueModal(${r.id})" style="margin-top:6px;padding:4px 8px;background:#6c63ff;color:white;border:none;border-radius:4px;cursor:pointer">Details</button>
                </div>
            `);
            m.addTo(dashMap);
            mapMarkers[r.id] = m;
        }
    });
}

/* ══════════════════════════════════════════════════════════════
   RENDER GRID
   ══════════════════════════════════════════════════════════════ */
function renderGrid() {
    if (timerInterval) clearInterval(timerInterval);

    let filtered = allReports;
    if (activeFilter !== 'all') filtered = filtered.filter(r => r.state === activeFilter);
    if (activeSevFilter !== 'all') filtered = filtered.filter(r => r.severity_level === activeSevFilter);

    loadingEl.hidden = true;

    if (!filtered.length) {
        grid.innerHTML = '';
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;
    grid.innerHTML = filtered.map(r => buildCard(r)).join('');

    filtered.forEach(r => {
        const btn = document.getElementById(`btn-transition-${r.id}`);
        if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); openTransitionModal(r); });
        const card = document.getElementById(`card-${r.id}`);
        if (card) card.addEventListener('click', () => openIssueModal(r.id));
    });

    timerInterval = setInterval(() => updateTimers(filtered), 1000);
}

function buildCard(r) {
    const sm = STATE_META[r.state] || STATE_META.SUBMITTED;
    const sevM = SEV_META[r.severity_level] || SEV_META.medium;
    const slaMeta = SLA_STATUS_META[r.sla_status || 'ON_TRACK'] || SLA_STATUS_META.ON_TRACK;
    const catIcon = CAT_ICONS[r.category] || '📋';
    const nextState = NEXT_STATE[r.state];
    const nextLabel = nextState ? NEXT_STATE_LABELS[nextState] : null;

    const hoursElapsed = r.assigned_at
        ? (Date.now() - new Date(r.assigned_at).getTime()) / 3_600_000
        : (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
    const circumference = 2 * Math.PI * 20;
    const pct = Math.min(hoursElapsed / 168, 1);
    const filled = circumference * pct;

    return `
<div class="report-card glass-card ${slaMeta.cls} ${slaMeta.flash ? 'sla-flash' : ''} ${r.is_emergency ? 'card-emergency' : ''}" id="card-${r.id}" style="cursor:pointer">
  ${r.is_emergency ? '<div class="card-emergency-badge">⚡ EMERGENCY</div>' : ''}
  <div class="sla-ring-wrap">
    <svg class="sla-ring" viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="20" class="sla-ring-bg"/>
      <circle cx="24" cy="24" r="20" class="sla-ring-fg"
        style="stroke:${slaMeta.ring};stroke-dasharray:${filled.toFixed(1)} ${circumference.toFixed(1)}"
        transform="rotate(-90 24 24)"/>
    </svg>
    <span class="sla-ring-icon">${catIcon}</span>
  </div>
  <div class="card-header">
    <div class="card-id-row">
      <span class="card-id">#${r.id}</span>
      <span class="state-badge ${sm.cls}">${sm.emoji} ${sm.label}</span>
      <span class="sev-badge" style="background:${sevM.color}20;color:${sevM.color};border:1px solid ${sevM.color}40">${sevM.icon} ${r.severity_level}</span>
    </div>
    <span class="card-category">${catIcon} ${capitalize(r.category)}</span>
  </div>
  <div class="sla-bar-wrap">
    <div class="sla-bar ${slaMeta.cls}">
      <span class="sla-bar-dot"></span>
      <span class="sla-bar-label">${slaMeta.label}</span>
      <span class="sla-timer" id="timer-${r.id}">${hoursElapsed.toFixed(1)}h</span>
    </div>
  </div>
  <div class="card-fields">
    ${r.ward_name ? `<div class="card-field"><span class="cf-key">🗺️ Ward</span><span class="cf-val">${r.ward_name}</span></div>` : ''}
    ${r.officer_name ? `<div class="card-field"><span class="cf-key">👤 Officer</span><span class="cf-val">${r.officer_name}</span></div>` : ''}
    <div class="card-field">
      <span class="cf-key">👥 Support</span>
      <span class="cf-val">${r.supporter_count} citizen${r.supporter_count !== 1 ? 's' : ''}</span>
    </div>
    <div class="card-field">
      <span class="cf-key">✔️ Verified</span>
      <span class="cf-val">${r.verification_count || 0} ${(r.verification_count || 0) !== 1 ? 'times' : 'time'}</span>
    </div>
    ${r.location_text ? `<div class="card-field"><span class="cf-key">📍 Location</span><span class="cf-val loc">${escHtml(r.location_text)}</span></div>` : ''}
  </div>
  <p class="card-desc">${escHtml((r.description || '').slice(0, 120))}${(r.description?.length || 0) > 120 ? '…' : ''}</p>
  ${nextLabel ? `
  <button id="btn-transition-${r.id}" class="btn btn-transition" data-report-id="${r.id}" data-to-state="${nextState}">
    ${nextLabel.icon} ${nextLabel.label}
  </button>` : `<div class="card-resolved-tag">${sm.emoji} ${sm.label}</div>`}
  ${r.sla_level >= 3 ? '<div class="escalation-badge">🚨 Commissioner notified</div>' : ''}
  ${r.sla_level === 2 ? '<div class="escalation-badge urgent">🔴 Exec. Engineer alerted</div>' : ''}
  ${r.sla_level === 1 ? '<div class="escalation-badge warn">⚠️ Junior Engineer notified</div>' : ''}
</div>`;
}

function updateTimers(reports) {
    reports.forEach(r => {
        const el = document.getElementById(`timer-${r.id}`);
        if (!el) return;
        const base = r.assigned_at ? r.assigned_at : r.created_at;
        const h = (Date.now() - new Date(base).getTime()) / 3_600_000;
        el.textContent = `${h.toFixed(1)}h`;
    });
}

/* ══════════════════════════════════════════════════════════════
   ISSUE DETAIL MODAL
   ══════════════════════════════════════════════════════════════ */
window.openIssueModal = async function (reportId) {
    activeReportId = reportId;
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;

    const sm = STATE_META[r.state] || STATE_META.SUBMITTED;
    modalIcon.textContent = sm.emoji;
    modalTitle.textContent = `#${r.id} — ${capitalize(r.category)}`;
    modalSub.textContent = `${r.ward_name || 'Unknown Ward'} · ${r.severity_level} severity · ${r.supporter_count} supporters`;

    // Set up transition tab
    setupTransitionTab(r);

    // Open modal
    issueModal.hidden = false;
    switchTab('transition');

    // Lazy load timeline and chat
    loadTimeline(reportId);
    loadChat(reportId);
};

function setupTransitionTab(r) {
    const nextState = NEXT_STATE[r.state];
    modalGeoWarn.hidden = true;
    modalGeoErr.hidden = true;

    if (!nextState) {
        modalConfirm.hidden = true;
        modalCancel.textContent = 'Close';
        return;
    }

    const lbl = NEXT_STATE_LABELS[nextState];
    pendingTransition = { reportId: r.id, toState: nextState, report: r };
    modalConfirm.hidden = false;
    modalConfirm.disabled = false;
    modalConfirmLabel.textContent = lbl.label;
    document.getElementById('modal-confirm-icon').textContent = lbl.icon;
    modalCancel.textContent = 'Cancel';

    if (nextState === 'IN_PROGRESS') {
        modalConfirm.disabled = true;
        modalGeoWarn.hidden = false;
        acquireOfficerGPS();
    }
}

function acquireOfficerGPS() {
    if (!navigator.geolocation) {
        modalGeoErr.hidden = false;
        modalGeoErrMsg.textContent = 'Geolocation not supported.';
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            pendingTransition.officerLat = pos.coords.latitude;
            pendingTransition.officerLon = pos.coords.longitude;
            modalGeoWarn.hidden = true;
            modalGeoErr.hidden = true;
            modalConfirm.disabled = false;
            modalConfirmLabel.textContent = `✅ Confirmed — GPS (${pos.coords.latitude.toFixed(4)}°, ${pos.coords.longitude.toFixed(4)}°)`;
        },
        (err) => {
            modalGeoErr.hidden = false;
            modalGeoErrMsg.textContent = `GPS error: ${err.message}`;
        },
        { enableHighAccuracy: true, timeout: 12000 }
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
            showToast(data.message, 4000);
            closeModal();
            await fetchDashboard();
        } else {
            let msg = data.error;
            if (data.distanceMetres) msg += ` (${data.distanceMetres}m from issue)`;
            modalGeoErr.hidden = false;
            modalGeoErrMsg.textContent = msg;
            modalConfirm.disabled = false;
            modalConfirmLabel.textContent = 'Retry';
        }
    } catch (err) {
        modalGeoErr.hidden = false;
        modalGeoErrMsg.textContent = 'Network error: ' + err.message;
        modalConfirm.disabled = false;
    }
}

// Transition modal (standalone — for quick card button press)
function openTransitionModal(report) {
    openIssueModal(report.id);
}

function closeModal() {
    issueModal.hidden = true;
    pendingTransition = null;
    activeReportId = null;
}

/* ── Modal Tabs ─────────────────────────────────────────────── */
function switchTab(tabName) {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    document.querySelectorAll('.modal-tab-content').forEach(c => {
        c.hidden = c.id !== `tab-${tabName}`;
        c.classList.toggle('active', c.id === `tab-${tabName}`);
    });
}

document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ── Timeline ────────────────────────────────────────────────── */
async function loadTimeline(reportId) {
    const timelineList = document.getElementById('timeline-list');
    timelineList.innerHTML = '<div class="loading-spinner"></div>';
    try {
        const res = await fetch(`/api/reports/${reportId}/timeline`);
        if (!res.ok) throw new Error('Failed to load');
        const { timeline, escalations } = await res.json();
        timelineList.innerHTML = timeline.map(t => `
            <div class="timeline-item">
                <div class="timeline-dot" style="background:${STATE_META[t.state]?.color || '#64748b'}"></div>
                <div class="timeline-content">
                    <strong>${STATE_META[t.state]?.emoji || '•'} ${t.state}</strong>
                    <p>${escHtml(t.label)}</p>
                    <small>${new Date(t.at).toLocaleString()}</small>
                </div>
            </div>
        `).join('') + (escalations.length ? `
            <div class="timeline-item">
                <div class="timeline-dot" style="background:#ef4444"></div>
                <div class="timeline-content">
                    <strong>🚨 Escalations (${escalations.length})</strong>
                    ${escalations.map(e => `<p>${e.action} → ${e.recipient} at ${new Date(e.sent_at).toLocaleString()}</p>`).join('')}
                </div>
            </div>
        ` : '');
    } catch (err) {
        timelineList.innerHTML = `<p style="color:#ef4444">Could not load timeline: ${err.message}</p>`;
    }
}

/* ── Chat ────────────────────────────────────────────────────── */
async function loadChat(reportId) {
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.innerHTML = '<div class="loading-spinner"></div>';
    try {
        const res = await fetch(`/api/reports/${reportId}/chat`);
        if (!res.ok) throw new Error('Failed to load');
        const { messages } = await res.json();
        chatMessages.innerHTML = '';
        messages.forEach(m => appendChatMessage(m));
        chatMessages.scrollTop = chatMessages.scrollHeight;
    } catch (err) {
        chatMessages.innerHTML = `<p style="color:#ef4444">Could not load chat: ${err.message}</p>`;
    }
}

function appendChatMessage(m) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;
    const div = document.createElement('div');
    div.className = `chat-msg chat-${m.sender_role}`;
    div.innerHTML = `
        <div class="chat-bubble">
            <div class="chat-sender">${m.sender_role === 'authority' ? '🏛️' : '👤'} <strong>${escHtml(m.sender_name)}</strong> <span class="chat-role-tag">${m.sender_role}</span></div>
            <p class="chat-text">${escHtml(m.message)}</p>
            <small class="chat-time">${new Date(m.sent_at).toLocaleTimeString()}</small>
        </div>
    `;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

document.getElementById('chat-send').addEventListener('click', async () => {
    if (!activeReportId) return;
    const role = document.getElementById('chat-role').value;
    const name = document.getElementById('chat-name').value.trim() || 'Anonymous';
    const msg = document.getElementById('chat-input').value.trim();
    if (!msg) return;

    try {
        const res = await fetch(`/api/reports/${activeReportId}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_role: role, sender_name: name, message: msg }),
        });
        if (res.ok) {
            const { message } = await res.json();
            appendChatMessage(message);
            document.getElementById('chat-input').value = '';
        }
    } catch (err) {
        showToast('❌ Failed to send message: ' + err.message);
    }
});

document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('chat-send').click();
});

/* ══════════════════════════════════════════════════════════════
   WARD PERFORMANCE TABLE
   ══════════════════════════════════════════════════════════════ */
function renderWardTable(wards) {
    const wrap = document.getElementById('ward-table-wrap');
    if (!wards || !wards.length) {
        wrap.innerHTML = '<p style="padding:1rem;color:#64748b">No ward data yet — submit some reports first.</p>';
        return;
    }
    wrap.innerHTML = `
        <table class="ward-table">
            <thead>
                <tr>
                    <th>Ward</th><th>Zone</th><th>Officer</th>
                    <th>Total</th><th>Resolved</th><th>Pending</th>
                    <th>Avg Resolution</th><th>On-Time %</th><th>Escalation %</th><th>Emergency</th>
                </tr>
            </thead>
            <tbody>
                ${wards.map(w => {
        const onTimePct = w.on_time_pct || 0;
        const escalPct = w.escalation_rate_pct || 0;
        const perfColor = onTimePct >= 80 ? '#10b981' : onTimePct >= 50 ? '#f59e0b' : '#ef4444';
        return `
                    <tr>
                        <td><strong>${escHtml(w.ward_name)}</strong></td>
                        <td><span class="zone-tag">${escHtml(w.zone || '—')}</span></td>
                        <td>${escHtml(w.officer_name)}</td>
                        <td class="num-cell">${w.total_reports || 0}</td>
                        <td class="num-cell ok">${w.resolved_count || 0}</td>
                        <td class="num-cell warn">${w.pending_count || 0}</td>
                        <td class="num-cell">${w.avg_resolution_hours != null ? `${w.avg_resolution_hours}h` : '—'}</td>
                        <td class="num-cell" style="color:${perfColor};font-weight:600">${w.on_time_pct != null ? `${w.on_time_pct}%` : '—'}</td>
                        <td class="num-cell ${escalPct > 30 ? 'crit' : escalPct > 15 ? 'warn' : 'ok'}">${w.escalation_rate_pct != null ? `${w.escalation_rate_pct}%` : '—'}</td>
                        <td class="num-cell ${w.emergency_count > 0 ? 'crit' : ''}">${w.emergency_count || 0}</td>
                    </tr>`;
    }).join('')}
            </tbody>
        </table>
    `;
}

/* ══════════════════════════════════════════════════════════════
   NEARBY COMPLAINTS
   ══════════════════════════════════════════════════════════════ */
function initNearby() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            userLat = pos.coords.latitude;
            userLon = pos.coords.longitude;
            document.getElementById('nearby-section').hidden = false;
            fetchNearby();
            if (dashMap) dashMap.setView([userLat, userLon], 14);
        },
        () => { /* GPS denied — hide section */ }
    );
}

async function fetchNearby() {
    if (!userLat || !userLon) return;
    try {
        const res = await fetch(`/api/reports/nearby?lat=${userLat}&lon=${userLon}&radius=${nearbyRadius}`);
        if (!res.ok) return;
        const { reports } = await res.json();
        renderNearby(reports);
    } catch { }
}

function renderNearby(reports) {
    const list = document.getElementById('nearby-list');
    if (!reports.length) {
        list.innerHTML = '<p style="padding:1rem;color:#64748b">No complaints within this radius.</p>';
        return;
    }
    list.innerHTML = reports.map(r => {
        const sm = STATE_META[r.state] || STATE_META.SUBMITTED;
        const sevM = SEV_META[r.severity_level] || SEV_META.medium;
        return `
        <div class="nearby-card" onclick="openIssueModal(${r.id})">
            <div class="nearby-dist">${Math.round(r.distance_m)}m</div>
            <div class="nearby-body">
                <div class="nearby-cat">${CAT_ICONS[r.category] || '📋'} ${capitalize(r.category)}</div>
                <div class="nearby-state">${sm.emoji} ${sm.label} &nbsp; <span style="color:${sevM.color}">${sevM.icon} ${r.severity_level}</span></div>
                <p class="nearby-desc">${escHtml((r.description || '').slice(0, 80))}…</p>
            </div>
        </div>`;
    }).join('');
}

const radiusSlider = document.getElementById('radius-slider');
radiusSlider.addEventListener('input', () => {
    nearbyRadius = parseInt(radiusSlider.value);
    document.getElementById('radius-val').textContent = nearbyRadius;
    fetchNearby();
});

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

document.querySelectorAll('.fpill-sev').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.fpill-sev').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSevFilter = btn.dataset.sev;
        renderGrid();
    });
});

/* ══════════════════════════════════════════════════════════════
   EVENTS
   ══════════════════════════════════════════════════════════════ */
document.getElementById('refresh-btn').addEventListener('click', () => {
    fetchDashboard();
    fetchEmergencyAlerts();
    fetchWardPerformance();
    fetchNearby();
    fetchMyReports();
});

modalConfirm.addEventListener('click', confirmTransition);
modalCancel.addEventListener('click', closeModal);
modalClose.addEventListener('click', closeModal);
issueModal.addEventListener('click', (e) => { if (e.target === issueModal) closeModal(); });

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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

/* ══════════════════════════════════════════════════════════════
   MY REPORTS
   ══════════════════════════════════════════════════════════════ */
async function fetchMyReports() {
    if (!reporterToken) {
        const loading = document.getElementById('my-reports-loading');
        if (loading) loading.hidden = true;
        document.getElementById('my-reports-empty').hidden = false;
        return;
    }
    try {
        const res = await fetch(`/api/reports/my?token=${encodeURIComponent(reporterToken)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { reports } = await res.json();
        renderMyReports(reports);
    } catch (err) {
        console.error('[Dashboard] My Reports error:', err.message);
        const grid = document.getElementById('my-reports-grid');
        grid.innerHTML = `<p style="padding:1rem;color:#ef4444">Could not load your reports: ${err.message}</p>`;
    }
}

function renderMyReports(reports) {
    const grid = document.getElementById('my-reports-grid');
    const loading = document.getElementById('my-reports-loading');
    const empty = document.getElementById('my-reports-empty');
    const count = document.getElementById('my-reports-count');

    if (loading) loading.hidden = true;

    if (!reports.length) {
        grid.innerHTML = '';
        empty.hidden = false;
        count.textContent = '';
        return;
    }

    empty.hidden = true;
    count.textContent = `${reports.length} report${reports.length !== 1 ? 's' : ''}`;

    grid.innerHTML = reports.map(r => {
        const sm = STATE_META[r.state] || STATE_META.SUBMITTED;
        const sevM = SEV_META[r.severity_level] || SEV_META.medium;
        const catIcon = CAT_ICONS[r.category] || '📋';
        const hoursAgo = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 3_600_000);
        const isMerged = r.parent_report_id != null;

        return `
<div class="my-report-card glass-card" onclick="openIssueModal(${r.id})" style="cursor:pointer">
  <div class="my-report-top">
    <span class="my-report-cat">${catIcon} ${capitalize(r.category)}</span>
    <span class="state-badge ${sm.cls}">${sm.emoji} ${sm.label}</span>
  </div>
  <p class="my-report-desc">${escHtml((r.description || '').slice(0, 120))}${(r.description?.length || 0) > 120 ? '…' : ''}</p>
  <div class="my-report-meta">
    <span class="sev-badge" style="background:${sevM.color}20;color:${sevM.color};border:1px solid ${sevM.color}40">${sevM.icon} ${r.severity_level}</span>
    ${r.ward_name ? `<span class="my-report-chip">🗺️ ${escHtml(r.ward_name)}</span>` : ''}
    ${r.officer_name ? `<span class="my-report-chip">👤 ${escHtml(r.officer_name)}</span>` : ''}
    <span class="my-report-chip">👥 ${r.supporter_count || 1}</span>
    <span class="my-report-chip">⏱️ ${hoursAgo}h ago</span>
    ${isMerged ? '<span class="my-report-chip merge-chip">🤝 Merged</span>' : ''}
  </div>
  <div class="my-report-id">#${r.id}</div>
</div>`;
    }).join('');
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
(async function init() {
    updateOnlineStatus();
    initMap();
    connectSSE();
    await fetchDashboard();
    await fetchEmergencyAlerts();
    await fetchWardPerformance();
    await fetchMyReports();
    initNearby();
    console.log('[Dashboard] CivicPulse Phase 5 initialized 🏛️');
})();
