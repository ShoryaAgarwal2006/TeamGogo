/**
 * analytics.js — CivicPulse Phase 4 Transparency & Analytics
 *
 * Three tabs:
 *  1. Public Feed   — Before/After photos + citizen acceptance voting
 *  2. Ward Rankings — Weighted leaderboard (ResRate×0.6 + RespScore×0.4)
 *  3. Heatmap       — Leaflet + heatmap.js + repeat-offender hotspots
 */

/* ── State ─────────────────────────────────────────────────── */
let map = null;
let heatLayer = null;
let mapInitialized = false;

/* ── DOM ───────────────────────────────────────────────────── */
const onlineDot = document.getElementById('online-dot');
const toast = document.getElementById('toast');
const toastMsg = document.getElementById('toast-msg');
const toastIcon = document.getElementById('toast-icon');

/* ── Voter token (anonymous fingerprint) ───────────────────── */
function getVoterToken() {
    let token = localStorage.getItem('civicpulse-voter-token');
    if (!token) {
        token = crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('civicpulse-voter-token', token);
    }
    return token;
}

/* ══════════════════════════════════════════════════════════════
   TAB SWITCHING
══════════════════════════════════════════════════════════════ */
document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true; p.classList.remove('active'); });

        btn.classList.add('active');
        const panelId = `panel-${btn.dataset.tab}`;
        const panel = document.getElementById(panelId);
        panel.hidden = false;
        panel.classList.add('active');

        // Lazy-init heatmap when first opened
        if (btn.dataset.tab === 'heatmap' && !mapInitialized) {
            initMap();
        }
    });
});

/* ══════════════════════════════════════════════════════════════
   TAB 1: PUBLIC FEED
══════════════════════════════════════════════════════════════ */
async function loadFeed() {
    const grid = document.getElementById('feed-grid');
    const loading = document.getElementById('feed-loading');
    const empty = document.getElementById('feed-empty');

    try {
        const res = await fetch('/api/analytics/feed?limit=50');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { reports } = await res.json();

        loading.remove();

        if (!reports.length) {
            empty.hidden = false;
            return;
        }

        grid.innerHTML = reports.map(r => buildFeedCard(r)).join('');

        // Attach vote handlers
        reports.forEach(r => attachVoteHandlers(r.id));

    } catch (err) {
        loading.innerHTML = `<p style="color:var(--clr-warn)">⚠️ ${err.message}</p>`;
    }
}

function buildFeedCard(r) {
    const catIcons = { pothole: '🕳️', streetlight: '💡', garbage: '🗑️', flooding: '🌊', sidewalk: '🚶', graffiti: '🎨', other: '📋' };
    const icon = catIcons[r.category] || '📋';
    const total = (r.accept_count || 0) + (r.reject_count || 0);
    const acceptPct = total > 0 ? Math.round((r.accept_count / total) * 100) : 0;
    const hasProof = !!r.after_image_url;
    const votedKey = `civicpulse-voted-${r.id}`;
    const myVote = localStorage.getItem(votedKey);
    const hoursAgo = r.resolved_at
        ? Math.floor((Date.now() - new Date(r.resolved_at).getTime()) / 3_600_000)
        : null;

    const distBadge = r.distance_m != null
        ? `<span class="proof-badge">✅ GPS verified (${Math.round(r.distance_m)}m on-site)</span>`
        : `<span class="proof-badge proof-badge-warn">⚠️ No GPS proof</span>`;

    const beforeSrc = r.before_image_url || null;
    const afterSrc = r.after_image_url || null;

    const photoSection = `
      <div class="photo-compare">
        <div class="photo-slot">
          ${beforeSrc
            ? `<img src="${escHtml(beforeSrc)}" alt="Before" loading="lazy"/>`
            : `<div class="no-photo">📷 No before photo</div>`}
          <span class="photo-label label-before">Before</span>
        </div>
        <div class="photo-slot">
          ${afterSrc
            ? `<img src="${escHtml(afterSrc)}" alt="After" loading="lazy"/>`
            : `<div class="no-photo">📷 No after photo</div>`}
          <span class="photo-label label-after">After</span>
        </div>
      </div>`;

    const voteSection = myVote
        ? `<div class="voted-badge">You voted: ${myVote === 'accept' ? '✅ Accepted' : '❌ Rejected'}</div>`
        : `<div class="vote-buttons">
             <button class="btn-accept" id="accept-${r.id}" onclick="castVote(${r.id},'accept')">✅ Accept Resolution</button>
             <button class="btn-reject" id="reject-${r.id}" onclick="castVote(${r.id},'reject')">❌ Reject</button>
           </div>`;

    const acceptedTag = r.resolution_accepted
        ? `<div class="vote-result-accepted">🎉 Community accepted this resolution</div>`
        : '';

    return `
<div class="feed-card" id="feedcard-${r.id}">
  <div class="feed-card-header">
    <span class="feed-report-id">${icon} Report #${r.id}</span>
    <span class="feed-category">${r.category}</span>
  </div>

  ${photoSection}

  <div class="feed-meta">
    ${r.ward_name ? `<span class="feed-meta-chip">🗺️ ${escHtml(r.ward_name)}</span>` : ''}
    ${r.officer_name ? `<span class="feed-meta-chip">👷 ${escHtml(r.officer_name)}</span>` : ''}
    ${r.supporter_count ? `<span class="feed-meta-chip">👥 ${r.supporter_count} supporters</span>` : ''}
    ${hoursAgo != null ? `<span class="feed-meta-chip">⏱️ Resolved ${hoursAgo}h ago</span>` : ''}
  </div>

  ${distBadge}

  <div class="vote-section">
    <div class="vote-bar-wrap">
      <div class="vote-counts">
        <span>✅ ${r.accept_count || 0} accepted</span>
        <span>${r.reject_count || 0} rejected ❌</span>
      </div>
      <div class="vote-bar-track">
        <div class="vote-bar-fill" id="vbar-${r.id}" style="width:${acceptPct}%"></div>
      </div>
    </div>
    ${acceptedTag}
    ${voteSection}
  </div>
</div>`;
}

function attachVoteHandlers(reportId) {
    // Handlers are inline onclick for simplicity — castVote is global
}

window.castVote = async function (reportId, vote) {
    const votedKey = `civicpulse-voted-${reportId}`;
    if (localStorage.getItem(votedKey)) {
        showToast('⚠️ You already voted on this report', 2500, '⚠️');
        return;
    }

    const acceptBtn = document.getElementById(`accept-${reportId}`);
    const rejectBtn = document.getElementById(`reject-${reportId}`);
    if (acceptBtn) acceptBtn.disabled = true;
    if (rejectBtn) rejectBtn.disabled = true;

    try {
        const res = await fetch(`/api/reports/${reportId}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vote, voterToken: getVoterToken() }),
        });
        const data = await res.json();

        if (res.ok) {
            localStorage.setItem(votedKey, vote);

            // Update bar
            const total = (data.accept_count || 0) + (data.reject_count || 0);
            const pct = total > 0 ? Math.round((data.accept_count / total) * 100) : 0;
            const bar = document.getElementById(`vbar-${reportId}`);
            if (bar) bar.style.width = `${pct}%`;

            // Replace vote buttons with voted badge
            const card = document.getElementById(`feedcard-${reportId}`);
            const btns = card?.querySelector('.vote-buttons');
            if (btns) {
                btns.outerHTML = `<div class="voted-badge">You voted: ${vote === 'accept' ? '✅ Accepted' : '❌ Rejected'} · ${data.accept_count} accept / ${data.reject_count} reject</div>`;
            }

            if (data.resolution_accepted) {
                showToast('🎉 Community has accepted this resolution!', 4000, '🎉');
            } else {
                showToast(vote === 'accept' ? '✅ Vote recorded' : '❌ Rejection recorded', 2500, vote === 'accept' ? '✅' : '❌');
            }
        } else {
            showToast('⚠️ ' + (data.error || 'Vote failed'), 3000, '⚠️');
            if (acceptBtn) acceptBtn.disabled = false;
            if (rejectBtn) rejectBtn.disabled = false;
        }
    } catch (err) {
        showToast('⚠️ Network error', 2500, '⚠️');
        if (acceptBtn) acceptBtn.disabled = false;
        if (rejectBtn) rejectBtn.disabled = false;
    }
};

/* ══════════════════════════════════════════════════════════════
   TAB 2: WARD RANKINGS
══════════════════════════════════════════════════════════════ */
async function loadRankings() {
    const wrap = document.getElementById('ranking-table-wrap');
    const loading = document.getElementById('rankings-loading');

    try {
        const res = await fetch('/api/analytics/ward-rankings');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { rankings, formula } = await res.json();

        if (!rankings.length) {
            wrap.innerHTML = '<p class="empty-state">No ward data yet.</p>';
            return;
        }

        wrap.innerHTML = buildRankingTable(rankings);
        // Animate score bars
        requestAnimationFrame(() => {
            rankings.forEach(r => {
                const fill = document.getElementById(`sfill-${r.ward_id}`);
                if (fill) fill.style.width = `${Math.round(r.score * 100)}%`;
            });
        });

    } catch (err) {
        wrap.innerHTML = `<p class="empty-state" style="color:var(--clr-warn)">⚠️ ${err.message}</p>`;
    }
}

function buildRankingTable(rankings) {
    const scoreColor = (s) => s >= 0.7 ? '#10b981' : s >= 0.4 ? '#f59e0b' : '#ef4444';
    const pctClass = (r) => r >= 0.7 ? 'good' : r >= 0.4 ? 'warn' : 'bad';

    const rows = rankings.map(r => {
        const sc = r.score ?? 0;
        const rr = r.resolution_rate ?? 0;
        const rt = r.response_time_score ?? 0;
        const color = scoreColor(sc);

        return `
<tr>
  <td class="rank-cell">${r.medal ? `<span class="medal">${r.medal}</span>` : `#${r.rank}`}</td>
  <td>
    <div class="ward-name-cell">${escHtml(r.ward_name)}</div>
    <div class="ward-zone">${escHtml(r.zone || '—')}</div>
    <div class="ward-officer">👤 ${escHtml(r.officer_name || '—')}</div>
  </td>
  <td class="score-cell">
    <div class="score-wrap">
      <span class="score-num" style="color:${color}">${(sc * 100).toFixed(1)}%</span>
      <div class="score-track">
        <div class="score-fill" id="sfill-${r.ward_id}" style="width:0%;background:${color}"></div>
      </div>
      <span class="score-breakdown">ResRate×0.6 + RespScore×0.4</span>
    </div>
  </td>
  <td class="pct-cell ${pctClass(rr)}">${(rr * 100).toFixed(0)}%</td>
  <td class="pct-cell ${pctClass(rt)}">${(rt * 100).toFixed(0)}%</td>
  <td class="hours-cell">${r.avg_response_hours != null ? r.avg_response_hours + 'h' : '—'}</td>
  <td class="pct-cell">${r.resolved ?? 0}/${r.total ?? 0}</td>
</tr>`;
    }).join('');

    return `
<table class="ranking-table">
  <thead>
    <tr>
      <th>Rank</th>
      <th>Ward</th>
      <th>Score</th>
      <th>Res. Rate</th>
      <th>Resp. Score</th>
      <th>Avg Hours</th>
      <th>Resolved</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
}

/* ══════════════════════════════════════════════════════════════
   TAB 3: HEATMAP
══════════════════════════════════════════════════════════════ */
function initMap() {
    mapInitialized = true;
    const mapEl = document.getElementById('map');

    // Default center: New Delhi
    map = L.map('map', { zoomControl: true }).setView([28.6139, 77.2090], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
        maxZoom: 18,
    }).addTo(map);

    setTimeout(() => { mapEl.classList.add('loaded'); map.invalidateSize(); }, 300);

    loadHeatmap();
    loadRepeatOffenders();
}

async function loadHeatmap() {
    const cat = document.getElementById('cat-filter').value;
    const days = document.getElementById('days-filter').value;
    const countEl = document.getElementById('heat-count');

    try {
        const res = await fetch(`/api/analytics/heatmap?category=${cat}&days=${days}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { points } = await res.json();

        countEl.textContent = points.length;

        // Remove old heat layer
        if (heatLayer) map.removeLayer(heatLayer);

        if (points.length) {
            const latlngs = points.map(p => [
                parseFloat(p.lat), parseFloat(p.lon),
                Math.min(parseFloat(p.value) / 10, 1),  // normalise weight 0–1
            ]);

            heatLayer = L.heatLayer(latlngs, {
                radius: 28,
                blur: 18,
                maxZoom: 16,
                gradient: { 0.2: '#3b82f6', 0.5: '#f59e0b', 0.8: '#ef4444', 1.0: '#7c3aed' },
            }).addTo(map);

            // Fit map to data
            const bounds = L.latLngBounds(points.map(p => [parseFloat(p.lat), parseFloat(p.lon)]));
            map.fitBounds(bounds, { padding: [40, 40] });
        } else {
            countEl.textContent = '0';
        }

    } catch (err) {
        countEl.textContent = '⚠️ error';
        console.error('[Heatmap]', err.message);
    }
}

async function loadRepeatOffenders() {
    const days = document.getElementById('days-filter').value;
    const roList = document.getElementById('ro-list');
    const loading = document.getElementById('ro-loading');
    const empty = document.getElementById('ro-empty');

    try {
        const res = await fetch(`/api/analytics/repeat-offenders?days=${days}&minCount=3`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { hotspots } = await res.json();

        if (loading) loading.remove();

        if (!hotspots.length) {
            empty.hidden = false;
            return;
        }
        empty.hidden = true;

        const catIcons = { pothole: '🕳️', streetlight: '💡', garbage: '🗑️', flooding: '🌊', sidewalk: '🚶', graffiti: '🎨', other: '📋' };

        roList.innerHTML = hotspots.map(h => {
            const icon = catIcons[h.category] || '📋';
            const firstDate = h.first_seen ? new Date(h.first_seen).toLocaleDateString('en-IN') : '—';
            const lastDate = h.last_seen ? new Date(h.last_seen).toLocaleDateString('en-IN') : '—';
            return `
<div class="ro-card">
  <div class="ro-head">
    <span class="ro-category">${icon} ${h.category}</span>
    <span class="ro-count">${h.incident_count}×</span>
  </div>
  <div class="ro-ward">📍 ${escHtml(h.ward_name || 'Unknown ward')} · ${escHtml(h.zone || '')}</div>
  <div class="ro-meta">
    First: ${firstDate} · Last: ${lastDate}<br>
    👥 ${h.total_supporters} total supporters
  </div>
</div>`;
        }).join('');

        // Mark repeat offenders on the map with a red pulse marker
        hotspots.forEach(h => {
            if (!h.lat || !h.lon) return;
            L.circleMarker([parseFloat(h.lat), parseFloat(h.lon)], {
                radius: 10 + Math.min(h.incident_count * 2, 20),
                color: '#ef4444',
                fillColor: '#ef4444',
                fillOpacity: 0.3,
                weight: 2,
            }).bindPopup(
                `<b>${catIcons[h.category] || '📋'} ${h.category}</b><br>
                 ${h.incident_count} incidents in ${days} days<br>
                 Ward: ${h.ward_name || '—'}`
            ).addTo(map);
        });

    } catch (err) {
        if (loading) loading.innerHTML = `<p style="color:var(--clr-warn)">⚠️ ${err.message}</p>`;
    }
}

document.getElementById('apply-heat-btn').addEventListener('click', () => {
    if (!mapInitialized) return;
    loadHeatmap();
    loadRepeatOffenders();
});

/* ══════════════════════════════════════════════════════════════
   ONLINE / OFFLINE
══════════════════════════════════════════════════════════════ */
function updateOnlineStatus() {
    onlineDot.classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

/* ══════════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════════ */
let toastTimer = null;
function showToast(msg, duration = 3000, icon = '✅') {
    toastIcon.textContent = icon;
    toastMsg.textContent = msg;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

/* ══════════════════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════════════════ */
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
(async function init() {
    updateOnlineStatus();
    await loadFeed();
    await loadRankings();
    console.log('[Analytics] CivicPulse Phase 4 Transparency Dashboard initialized 🏛️');
})();
