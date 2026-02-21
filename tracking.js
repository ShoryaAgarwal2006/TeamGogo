/**
 * tracking.js — CivicPulse Live Issue Tracker
 *
 * Full-screen interactive map for citizens:
 * - SSE live feed for real-time updates
 * - Leaflet map with color-coded pins
 * - Sidebar with filterable issue list
 * - Emergency ticker bar
 * - Slide-in detail panel: description, timeline, chat, verify
 */

let allReports = [];
let activeReportId = null;
let map = null;
let markers = {};
let userLat = null, userLon = null;
let nearbyRadiusM = 0; // 0 = show all
let activeSev = 'all';
let sseConn = null;
let voterToken = null;

/* ── Voter Token ─────────────────────────────────────────── */
voterToken = localStorage.getItem('civicpulse-voter-token');
if (!voterToken) {
    voterToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('civicpulse-voter-token', voterToken);
}

/* ── Config ─────────────────────────────────────────────── */
const STATE_META = {
    SUBMITTED: { label: 'Submitted', emoji: '📋', color: '#64748b' },
    VERIFIED: { label: 'Verified', emoji: '✅', color: '#22d3ee' },
    ASSIGNED: { label: 'Assigned', emoji: '👷', color: '#a78bfa' },
    IN_PROGRESS: { label: 'In Progress', emoji: '🔧', color: '#f59e0b' },
    RESOLVED: { label: 'Resolved', emoji: '🎉', color: '#10b981' },
};
const SEV_META = {
    critical: { color: '#dc2626', icon: '🔥' },
    high: { color: '#ef4444', icon: '🔴' },
    medium: { color: '#f59e0b', icon: '🟡' },
    low: { color: '#10b981', icon: '🟢' },
};
const CAT_ICONS = { pothole: '🕳️', streetlight: '💡', garbage: '🗑️', graffiti: '🎨', flooding: '🌊', sidewalk: '🚶', other: '📋' };

/* ── Init Map ───────────────────────────────────────────── */
function initMap() {
    map = L.map('track-map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
    }).addTo(map);
    map.setView([28.62, 77.22], 12);

    // Try user location
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
            userLat = pos.coords.latitude;
            userLon = pos.coords.longitude;
            map.setView([userLat, userLon], 14);
            L.circle([userLat, userLon], { radius: 60, color: '#6c63ff', fillColor: '#6c63ff', fillOpacity: .15 })
                .addTo(map)
                .bindPopup('📍 Your location');
        });
    }
}

/* ── REST fallback: fetch reports immediately so map isn't stuck ── */
async function fetchReportsREST() {
    try {
        const res = await fetch('/api/reports?limit=100');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { reports } = await res.json();
        // Only apply if SSE hasn't already populated allReports
        if (!allReports.length && reports.length) {
            allReports = reports;
            renderAll();
        }
    } catch (err) {
        console.warn('[Tracking] REST fallback failed:', err.message);
    }
}

/* ── SSE ────────────────────────────────────────────────── */
function connectSSE() {
    const statusEl = document.getElementById('sse-status');

    // Immediately load via REST so sidebar isn't blank while SSE connects
    fetchReportsREST();

    sseConn = new EventSource('/api/live-feed');

    sseConn.onopen = () => {
        statusEl.textContent = '⬤ Live';
        statusEl.style.color = '#10b981';
    };
    sseConn.onmessage = (evt) => {
        try {
            const data = JSON.parse(evt.data);
            if (data.type === 'snapshot') {
                allReports = data.reports || [];
                renderAll();
            } else if (data.type === 'chat' && data.reportId === activeReportId) {
                appendChatMsg(data.msg);
            }
        } catch { }
    };
    sseConn.onerror = () => {
        statusEl.textContent = '⬤ Reconnecting…';
        statusEl.style.color = '#f59e0b';
        // On SSE error, re-poll via REST every 10s as backup
        setTimeout(fetchReportsREST, 10000);
    };
}

/* ── Render All ─────────────────────────────────────────── */
function renderAll() {
    renderEmergencyTicker();
    updateMapPins();
    renderSidebarList();
}

/* ── Emergency Ticker ───────────────────────────────────── */
function renderEmergencyTicker() {
    const emergencies = allReports.filter(r => r.is_emergency && r.state !== 'RESOLVED');
    const ticker = document.getElementById('emergency-ticker');
    const content = document.getElementById('ticker-content');
    if (!emergencies.length) { ticker.hidden = true; return; }
    ticker.hidden = false;
    content.innerHTML = emergencies.map(e =>
        `<span class="ticker-item" onclick="openDetail(${e.id})">⚡ ${escHtml(e.category)} in ${escHtml(e.ward_name || 'Unknown')} — ${escHtml((e.description || '').slice(0, 60))}</span>`
    ).join(' &nbsp;&nbsp;|&nbsp;&nbsp; ');
}

/* ── Map Pins ───────────────────────────────────────────── */
function updateMapPins() {
    if (!map) return;
    const current = new Set(filteredReports().map(r => r.id));

    // Remove stale
    Object.keys(markers).forEach(id => {
        if (!current.has(parseInt(id))) { map.removeLayer(markers[id]); delete markers[id]; }
    });

    filteredReports().forEach(r => {
        if (!r.gps_lat || !r.gps_lon) return;
        const color = r.is_emergency ? '#dc2626' : (STATE_META[r.state]?.color || '#64748b');
        const pulse = r.is_emergency || (r.sla_level || 0) >= 2;
        const icon = L.divIcon({
            className: '',
            html: `<div style="background:${color};width:${r.is_emergency ? 18 : 14}px;height:${r.is_emergency ? 18 : 14}px;border-radius:50%;border:2px solid rgba(255,255,255,.8);box-shadow:0 0 ${pulse ? '12px' : '4px'} ${color}${pulse ? '99' : '44'}"></div>`,
            iconSize: [18, 18], iconAnchor: [9, 9],
        });
        if (markers[r.id]) {
            markers[r.id].setLatLng([r.gps_lat, r.gps_lon]);
            markers[r.id].setIcon(icon);
        } else {
            const m = L.marker([r.gps_lat, r.gps_lon], { icon });
            m.on('click', () => openDetail(r.id));
            m.addTo(map);
            markers[r.id] = m;
        }
    });
}

/* ── Sidebar List ───────────────────────────────────────── */
function renderSidebarList() {
    const list = document.getElementById('issue-list');
    const fr = filteredReports();
    document.getElementById('issue-count').textContent = fr.length;

    if (!fr.length) {
        list.innerHTML = '<div class="empty-msg">No issues in this area</div>';
        return;
    }

    list.innerHTML = fr.map(r => {
        const sm = STATE_META[r.state] || STATE_META.SUBMITTED;
        const sm2 = SEV_META[r.severity_level] || SEV_META.medium;
        const hoursOld = ((Date.now() - new Date(r.created_at).getTime()) / 3_600_000).toFixed(0);
        return `
        <div class="issue-row ${r.is_emergency ? 'issue-emergency' : ''} ${activeReportId === r.id ? 'issue-active' : ''}"
             id="issue-row-${r.id}"
             onclick="openDetail(${r.id})">
            <div class="issue-row-icon">${CAT_ICONS[r.category] || '📋'}</div>
            <div class="issue-row-body">
                <div class="issue-row-title">
                    <span class="issue-row-cat">${capitalize(r.category)}</span>
                    <span class="issue-row-sev" style="color:${sm2.color}">${sm2.icon}</span>
                    ${r.is_emergency ? '<span class="emerg-tag">⚡</span>' : ''}
                </div>
                <div class="issue-row-badges">
                    <span class="issue-row-state" style="color:${sm.color}">${sm.emoji} ${sm.label}</span>
                    <span class="issue-row-time">${hoursOld}h ago</span>
                </div>
                <p class="issue-row-desc">${escHtml((r.description || '').slice(0, 65))}…</p>
            </div>
        </div>`;
    }).join('');
}

function filteredReports() {
    let fr = allReports;
    if (activeSev !== 'all') fr = fr.filter(r => r.severity_level === activeSev);
    if (nearbyRadiusM > 0 && userLat && userLon) {
        fr = fr.filter(r => {
            if (!r.gps_lat || !r.gps_lon) return false;
            const d = haversine(userLat, userLon, r.gps_lat, r.gps_lon);
            return d <= nearbyRadiusM;
        });
    }
    return fr.sort((a, b) => (b.is_emergency ? 1 : 0) - (a.is_emergency ? 1 : 0) || (b.sla_level || 0) - (a.sla_level || 0));
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Detail Panel ───────────────────────────────────────── */
window.openDetail = async function (reportId) {
    activeReportId = reportId;
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;

    // Highlight in sidebar
    document.querySelectorAll('.issue-row').forEach(el => el.classList.remove('issue-active'));
    const row = document.getElementById(`issue-row-${reportId}`);
    if (row) row.classList.add('issue-active');

    // Fly map to pin
    if (r.gps_lat && r.gps_lon && map) {
        map.flyTo([r.gps_lat, r.gps_lon], 16, { duration: 0.5 });
    }

    const sm = STATE_META[r.state] || STATE_META.SUBMITTED;
    const sm2 = SEV_META[r.severity_level] || SEV_META.medium;

    document.getElementById('dp-id').textContent = `#${r.id}`;
    document.getElementById('dp-state').textContent = `${sm.emoji} ${sm.label}`;
    document.getElementById('dp-state').style.color = sm.color;
    document.getElementById('dp-sev').textContent = `${sm2.icon} ${r.severity_level}`;
    document.getElementById('dp-sev').style.background = `${sm2.color}20`;
    document.getElementById('dp-sev').style.color = sm2.color;
    document.getElementById('dp-category').textContent = `${CAT_ICONS[r.category] || '📋'} ${capitalize(r.category)}`;
    document.getElementById('dp-desc').textContent = r.description || '—';
    document.getElementById('dp-ward').textContent = r.ward_name || '—';
    document.getElementById('dp-officer').textContent = r.officer_name || '—';
    document.getElementById('dp-supporters').textContent = `${r.supporter_count} citizen${r.supporter_count !== 1 ? 's' : ''}`;
    document.getElementById('dp-verified').textContent = `${r.verification_count || 0} citizen${(r.verification_count || 0) !== 1 ? 's' : ''}`;
    document.getElementById('dp-created').textContent = new Date(r.created_at).toLocaleString();

    document.getElementById('detail-panel').hidden = false;
    switchDetailTab('dp-tab-timeline');

    // Check if already verified
    checkVerified(reportId);
    loadDetailTimeline(reportId);
    loadDetailChat(reportId);
};

document.getElementById('dp-close').addEventListener('click', () => {
    document.getElementById('detail-panel').hidden = true;
    activeReportId = null;
    document.querySelectorAll('.issue-row').forEach(el => el.classList.remove('issue-active'));
});

/* ── Verify ─────────────────────────────────────────────── */
async function checkVerified(reportId) {
    const btn = document.getElementById('dp-verify-btn');
    const msg = document.getElementById('dp-verify-msg');
    btn.disabled = false;
    msg.textContent = '';
    try {
        const res = await fetch(`/api/reports/${reportId}/verify/check?voter_token=${voterToken}`);
        if (res.ok) {
            const { verified } = await res.json();
            if (verified) {
                btn.disabled = true;
                btn.textContent = '✔️ Already Verified';
                msg.textContent = 'You have already verified this issue.';
            }
        }
    } catch { }
}

document.getElementById('dp-verify-btn').addEventListener('click', async () => {
    if (!activeReportId) return;
    const btn = document.getElementById('dp-verify-btn');
    const msg = document.getElementById('dp-verify-msg');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
        const res = await fetch(`/api/reports/${activeReportId}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voter_token: voterToken }),
        });
        const data = await res.json();
        if (res.ok) {
            msg.textContent = data.message;
            msg.style.color = '#10b981';
            btn.textContent = '✔️ Verified!';
            // Update local count
            const r = allReports.find(x => x.id === activeReportId);
            if (r) { r.verification_count = data.verificationCount; r.supporter_count = data.supporterCount; }
            document.getElementById('dp-verified').textContent = `${data.verificationCount} citizen${data.verificationCount !== 1 ? 's' : ''}`;
        } else if (data.alreadyVerified) {
            btn.textContent = '✔️ Already Verified';
            msg.textContent = 'You have already verified this issue.';
        } else {
            btn.disabled = false;
            btn.textContent = '✔️ Verify This Issue';
            msg.textContent = data.error || 'Failed to verify';
            msg.style.color = '#ef4444';
        }
    } catch (err) {
        btn.disabled = false;
        btn.textContent = '✔️ Verify This Issue';
        msg.textContent = 'Network error: ' + err.message;
        msg.style.color = '#ef4444';
    }
});

/* ── Timeline ────────────────────────────────────────────── */
async function loadDetailTimeline(reportId) {
    const el = document.getElementById('dp-timeline');
    el.innerHTML = '<div class="loading-row"><div class="loading-spinner-sm"></div></div>';
    try {
        const res = await fetch(`/api/reports/${reportId}/timeline`);
        if (!res.ok) throw new Error('Failed');
        const { timeline } = await res.json();
        el.innerHTML = timeline.map(t => `
            <div class="dp-tl-item">
                <div class="dp-tl-dot" style="background:${STATE_META[t.state]?.color || '#64748b'}"></div>
                <div class="dp-tl-body">
                    <strong>${STATE_META[t.state]?.emoji || '•'} ${t.state}</strong>
                    <p>${escHtml(t.label)}</p>
                    <small>${new Date(t.at).toLocaleString()}</small>
                </div>
            </div>
        `).join('');
    } catch {
        el.innerHTML = '<p class="load-err">Could not load timeline.</p>';
    }
}

/* ── Chat ────────────────────────────────────────────────── */
async function loadDetailChat(reportId) {
    const el = document.getElementById('dp-chat-msgs');
    el.innerHTML = '<div class="loading-row"><div class="loading-spinner-sm"></div></div>';
    try {
        const res = await fetch(`/api/reports/${reportId}/chat`);
        if (!res.ok) throw new Error('Failed');
        const { messages } = await res.json();
        el.innerHTML = '';
        messages.forEach(m => appendChatMsg(m));
        el.scrollTop = el.scrollHeight;
    } catch {
        el.innerHTML = '<p class="load-err">Could not load chat.</p>';
    }
}

function appendChatMsg(m) {
    const el = document.getElementById('dp-chat-msgs');
    if (!el) return;
    const div = document.createElement('div');
    div.className = `dp-chat-msg dp-chat-${m.sender_role}`;
    div.innerHTML = `
        <div class="dp-chat-bubble">
            <div class="dp-chat-sender">${m.sender_role === 'authority' ? '🏛️' : '👤'} <strong>${escHtml(m.sender_name)}</strong></div>
            <p>${escHtml(m.message)}</p>
            <small>${new Date(m.sent_at).toLocaleTimeString()}</small>
        </div>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
}

document.getElementById('dp-chat-send').addEventListener('click', async () => {
    if (!activeReportId) return;
    const name = document.getElementById('dp-chat-name').value.trim() || 'Citizen';
    const msg = document.getElementById('dp-chat-msg').value.trim();
    if (!msg) return;

    try {
        const res = await fetch(`/api/reports/${activeReportId}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_role: 'citizen', sender_name: name, message: msg }),
        });
        if (res.ok) {
            const { message } = await res.json();
            appendChatMsg(message);
            document.getElementById('dp-chat-msg').value = '';
        }
    } catch { }
});

document.getElementById('dp-chat-msg').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('dp-chat-send').click();
});

/* ── Detail Tabs ─────────────────────────────────────────── */
function switchDetailTab(tabId) {
    document.querySelectorAll('.dp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
    document.querySelectorAll('.dp-tab-content').forEach(c => {
        c.hidden = c.id !== tabId;
        c.classList.toggle('active', c.id === tabId);
    });
}
document.querySelectorAll('.dp-tab').forEach(btn => {
    btn.addEventListener('click', () => switchDetailTab(btn.dataset.tab));
});

/* ── Filters ─────────────────────────────────────────────── */
document.querySelectorAll('.sfpill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.sfpill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSev = btn.dataset.sev;
        renderAll();
    });
});

const sbRadius = document.getElementById('sb-radius');
sbRadius.addEventListener('input', () => {
    nearbyRadiusM = parseInt(sbRadius.value);
    document.getElementById('sb-radius-val').textContent = nearbyRadiusM > 0 ? `${nearbyRadiusM}m` : 'All';
    renderAll();
});

/* ── Utils ───────────────────────────────────────────────── */
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

/* ── Init ────────────────────────────────────────────────── */
(function init() {
    initMap();
    connectSSE();
})();
