/**
 * routes/live.js — Server-Sent Events (SSE) Live Feed
 *
 * GET /api/live-feed
 *
 * Streams real-time report updates to all connected clients.
 * Sends a full snapshot every 10s plus event-driven pushes from other routes.
 * global.sseClients is used by chat.js and verify.js to push targeted events.
 */

const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

// Global registry of connected SSE clients
global.sseClients = new Set();

/**
 * broadcastReports() — Sends latest reports snapshot to all clients
 */
async function broadcastReports() {
    if (global.sseClients.size === 0) return;

    try {
        const { rows } = await pool.query(`
            SELECT
                r.id, r.category, r.description, r.location_text,
                r.state, r.status, r.sla_level, r.severity_level,
                r.is_emergency, r.supporter_count, r.verification_count,
                r.gps_lat, r.gps_lon, r.image_url,
                r.assigned_at, r.created_at, r.updated_at,
                r.verified_at, r.in_progress_at, r.resolved_at,
                w.ward_name, w.zone, w.officer_name,
                EXTRACT(EPOCH FROM (NOW() - COALESCE(r.assigned_at, r.created_at))) / 3600 AS hours_elapsed
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.state NOT IN ('MERGED')
              AND r.parent_report_id IS NULL
            ORDER BY r.is_emergency DESC, r.sla_level DESC, r.created_at DESC
            LIMIT 200
        `);

        const payload = JSON.stringify({ type: 'snapshot', reports: rows, ts: Date.now() });
        global.sseClients.forEach(client => {
            try { client.write(`data: ${payload}\n\n`); }
            catch { global.sseClients.delete(client); }
        });
    } catch (err) {
        console.error('[SSE] broadcastReports error:', err.message);
    }
}

// Send snapshot every 10 seconds
setInterval(broadcastReports, 10_000);

/* GET /api/live-feed */
router.get('/live-feed', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    // Send initial heartbeat
    res.write('data: {"type":"connected"}\n\n');

    // Register client
    global.sseClients.add(res);
    console.log(`[SSE] Client connected. Total: ${global.sseClients.size}`);

    // Send immediate snapshot
    broadcastReports();

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); }
        catch { clearInterval(heartbeat); }
    }, 30_000);

    // Cleanup on disconnect
    req.on('close', () => {
        global.sseClients.delete(res);
        clearInterval(heartbeat);
        console.log(`[SSE] Client disconnected. Total: ${global.sseClients.size}`);
    });
});

/* POST /api/live-feed/broadcast — Internal trigger to send snapshot immediately */
router.post('/live-feed/broadcast', async (req, res) => {
    await broadcastReports();
    res.json({ sent: global.sseClients.size });
});

module.exports = router;
