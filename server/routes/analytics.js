/**
 * routes/analytics.js — CivicPulse Phase 4: Transparency & Proof API
 *
 * POST /api/reports/:id/proof          — Upload "after" photo to resolve a report
 * GET  /api/reports/:id/proof          — Get before/after photos + acceptance counts
 * POST /api/reports/:id/vote           — Citizen accept/reject vote
 * GET  /api/analytics/ward-rankings    — Weighted ward leaderboard
 * GET  /api/analytics/heatmap          — {lat,lon,value} points for heatmap.js
 * GET  /api/analytics/feed             — Public resolved feed (before+after pairs)
 * GET  /api/analytics/repeat-offenders — Locations with repeat failures
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db/pool');
const { haversineDistance } = require('../lib/stateMachine');

const router = express.Router();

// ── Multer for resolution "after" photos ────────────────────
const storage = multer.diskStorage({
    destination: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `proof-${req.params.id}-${Date.now()}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files allowed'));
    },
});

/* ═══════════════════════════════════════════════════════════════
   POST /api/reports/:id/proof
   Multipart body: afterPhoto (file), officerLat, officerLon

   Protocol:
     1. Officer takes "after" photo via camera on-site
     2. GPS coordinates verified ≤ 100m from report location
     3. Photo saved, resolution_proof record created
     4. Report state transitioned to RESOLVED, resolved_at stamped
   ═══════════════════════════════════════════════════════════════ */
router.post('/reports/:id/proof', upload.single('afterPhoto'), async (req, res) => {
    const { id } = req.params;
    const { officerLat, officerLon } = req.body;

    if (!req.file) {
        return res.status(400).json({ error: '"afterPhoto" image file is required' });
    }
    if (officerLat == null || officerLon == null) {
        return res.status(400).json({ error: 'officerLat and officerLon are required' });
    }

    const lat = parseFloat(officerLat);
    const lon = parseFloat(officerLon);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Fetch report
        const { rows } = await client.query(
            `SELECT id, state, gps_lat, gps_lon, image_url, category
             FROM reports WHERE id = $1 FOR UPDATE`,
            [id]
        );

        if (!rows.length) {
            throw Object.assign(new Error(`Report #${id} not found`), { status: 404 });
        }

        const report = rows[0];

        if (report.state !== 'IN_PROGRESS') {
            throw Object.assign(
                new Error(`Report must be IN_PROGRESS to submit proof. Current state: ${report.state}`),
                { status: 409 }
            );
        }

        // GPS verification — officer must be on-site
        let distanceM = null;
        if (report.gps_lat != null && report.gps_lon != null) {
            distanceM = haversineDistance(lat, lon, report.gps_lat, report.gps_lon);
            if (distanceM > 100) {
                throw Object.assign(
                    new Error(`Officer must be within 100m of the issue. Distance: ${distanceM.toFixed(0)}m`),
                    { status: 403, distanceMetres: distanceM }
                );
            }
        } else {
            // No GPS on original report — use 0 distance (cannot enforce)
            distanceM = 0;
            console.warn(`[Proof] Report #${id} has no GPS — skipping geo-fence`);
        }

        const afterImageUrl = `/uploads/${req.file.filename}`;

        // Save resolution proof
        await client.query(
            `INSERT INTO resolution_proofs (report_id, after_image_url, officer_lat, officer_lon, distance_m)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (report_id) DO UPDATE
               SET after_image_url = EXCLUDED.after_image_url,
                   officer_lat = EXCLUDED.officer_lat,
                   officer_lon = EXCLUDED.officer_lon,
                   distance_m = EXCLUDED.distance_m,
                   submitted_at = NOW()`,
            [id, afterImageUrl, lat, lon, distanceM]
        );

        // Transition report to RESOLVED
        await client.query(
            `UPDATE reports
             SET state = 'RESOLVED', status = 'resolved', resolved_at = NOW()
             WHERE id = $1`,
            [id]
        );

        await client.query('COMMIT');

        console.log(`[Proof] Report #${id} resolved with photo proof (${distanceM.toFixed(0)}m from site)`);

        res.json({
            success: true,
            message: `🎉 Report #${id} resolved with GPS-verified photo proof`,
            proof: {
                reportId: id,
                afterImageUrl,
                distanceMetres: Math.round(distanceM),
                submittedAt: new Date().toISOString(),
            },
        });

    } catch (err) {
        await client.query('ROLLBACK');
        const status = err.status || 500;
        res.status(status).json({
            error: err.message,
            ...(err.distanceMetres != null && { distanceMetres: Math.round(err.distanceMetres) }),
        });
    } finally {
        client.release();
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/reports/:id/proof
   Returns before + after images and current acceptance vote counts
   ═══════════════════════════════════════════════════════════════ */
router.get('/reports/:id/proof', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query(
            `SELECT
               r.id, r.category, r.description, r.location_text, r.state,
               r.image_url AS before_image_url, r.resolved_at,
               r.accept_count, r.reject_count, r.resolution_accepted,
               r.gps_lat, r.gps_lon,
               w.ward_name, w.officer_name,
               p.after_image_url, p.distance_m, p.officer_lat, p.officer_lon, p.submitted_at
             FROM reports r
             LEFT JOIN city_wards w ON r.ward_id = w.ward_id
             LEFT JOIN resolution_proofs p ON p.report_id = r.id
             WHERE r.id = $1`,
            [id]
        );

        if (!rows.length) {
            return res.status(404).json({ error: `Report #${id} not found` });
        }

        res.json(rows[0]);

    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch proof', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   POST /api/reports/:id/vote
   Body: { vote: 'accept'|'reject', voterToken: string }

   Anonymous, idempotent — one vote per browser token per report.
   Updates accept_count / reject_count on the report atomically.
   ═══════════════════════════════════════════════════════════════ */
router.post('/reports/:id/vote', async (req, res) => {
    const { id } = req.params;
    const { vote, voterToken } = req.body;

    if (!['accept', 'reject'].includes(vote)) {
        return res.status(400).json({ error: 'vote must be "accept" or "reject"' });
    }
    if (!voterToken || voterToken.length < 8) {
        return res.status(400).json({ error: 'voterToken is required (min 8 chars)' });
    }

    // Sanitize token — hash it server-side for privacy
    const tokenHash = crypto.createHash('sha256').update(voterToken).digest('hex').slice(0, 32);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check report exists and is resolved
        const { rows: reportRows } = await client.query(
            'SELECT id, state, accept_count, reject_count FROM reports WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (!reportRows.length) {
            throw Object.assign(new Error(`Report #${id} not found`), { status: 404 });
        }
        const report = reportRows[0];
        if (report.state !== 'RESOLVED') {
            throw Object.assign(
                new Error('Can only vote on RESOLVED reports'),
                { status: 409 }
            );
        }

        // Check existing vote
        const { rows: existing } = await client.query(
            'SELECT vote FROM acceptance_votes WHERE report_id = $1 AND voter_token = $2',
            [id, tokenHash]
        );

        let previousVote = null;
        if (existing.length) {
            previousVote = existing[0].vote;
            if (previousVote === vote) {
                // Same vote — idempotent success
                await client.query('ROLLBACK');
                return res.json({
                    success: true,
                    message: 'Vote already recorded',
                    alreadyVoted: true,
                    vote,
                    accept_count: report.accept_count,
                    reject_count: report.reject_count,
                });
            }
            // Changed vote — update
            await client.query(
                'UPDATE acceptance_votes SET vote = $1, voted_at = NOW() WHERE report_id = $2 AND voter_token = $3',
                [vote, id, tokenHash]
            );
        } else {
            // New vote
            await client.query(
                'INSERT INTO acceptance_votes (report_id, voter_token, vote) VALUES ($1, $2, $3)',
                [id, tokenHash, vote]
            );
        }

        // Recount from DB (single source of truth)
        const { rows: counts } = await client.query(
            `SELECT
               COUNT(*) FILTER (WHERE vote = 'accept') AS accept_count,
               COUNT(*) FILTER (WHERE vote = 'reject') AS reject_count
             FROM acceptance_votes WHERE report_id = $1`,
            [id]
        );

        const acceptCount = parseInt(counts[0].accept_count);
        const rejectCount = parseInt(counts[0].reject_count);
        const accepted = acceptCount > rejectCount && acceptCount >= 3;

        await client.query(
            `UPDATE reports SET accept_count = $1, reject_count = $2, resolution_accepted = $3 WHERE id = $4`,
            [acceptCount, rejectCount, accepted, id]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            vote,
            accept_count: acceptCount,
            reject_count: rejectCount,
            resolution_accepted: accepted,
        });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally {
        client.release();
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/analytics/feed
   Returns resolved reports with before+after photos for public feed.
   Ordered by resolved_at DESC.
   ═══════════════════════════════════════════════════════════════ */
router.get('/analytics/feed', async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    try {
        const { rows } = await pool.query(
            `SELECT
               r.id, r.category, r.description, r.location_text,
               r.image_url AS before_image_url,
               r.resolved_at, r.accept_count, r.reject_count,
               r.resolution_accepted, r.supporter_count, r.created_at,
               r.gps_lat, r.gps_lon,
               w.ward_name, w.zone, w.officer_name,
               p.after_image_url, p.distance_m, p.submitted_at
             FROM reports r
             LEFT JOIN city_wards w ON r.ward_id = w.ward_id
             LEFT JOIN resolution_proofs p ON p.report_id = r.id
             WHERE r.state = 'RESOLVED'
               AND r.parent_report_id IS NULL
             ORDER BY r.resolved_at DESC NULLS LAST
             LIMIT $1 OFFSET $2`,
            [parseInt(limit), parseInt(offset)]
        );

        res.json({ reports: rows, count: rows.length });

    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch feed', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/analytics/ward-rankings
   Weighted leaderboard:
     Score = (ResolutionRate × 0.6) + (AvgResponseTimeScore × 0.4)
   ═══════════════════════════════════════════════════════════════ */
router.get('/analytics/ward-rankings', async (req, res) => {
    try {
        const { rows } = await pool.query(`
      WITH ward_stats AS (
        SELECT
          w.ward_id,
          w.ward_name,
          w.zone,
          w.officer_name,
          COUNT(r.id)                                                     AS total,
          COUNT(r.id) FILTER (WHERE r.state = 'RESOLVED')                 AS resolved,
          COUNT(r.id) FILTER (WHERE r.state NOT IN ('RESOLVED','MERGED'))  AS pending,
          AVG(
            CASE WHEN r.state = 'RESOLVED' AND r.assigned_at IS NOT NULL AND r.resolved_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (r.resolved_at - r.assigned_at)) / 3600
              ELSE NULL
            END
          )                                                               AS avg_response_hours,
          AVG(r.supporter_count)                                          AS avg_supporters,
          SUM(r.accept_count)                                             AS total_accepts,
          SUM(r.reject_count)                                             AS total_rejects
        FROM city_wards w
        LEFT JOIN reports r
          ON r.ward_id = w.ward_id
          AND r.parent_report_id IS NULL
        GROUP BY w.ward_id, w.ward_name, w.zone, w.officer_name
      )
      SELECT
        ward_id, ward_name, zone, officer_name,
        total::int, resolved::int, pending::int,
        ROUND(avg_response_hours::numeric, 1)       AS avg_response_hours,
        ROUND(avg_supporters::numeric, 1)           AS avg_supporters,
        total_accepts::int, total_rejects::int,
        -- Resolution Rate (0–1)
        CASE WHEN total > 0
          THEN ROUND((resolved::numeric / total), 4)
          ELSE 0
        END                                         AS resolution_rate,
        -- Response Time Score: clamped 0–1, best is 0h worst is 168h
        CASE WHEN avg_response_hours IS NOT NULL
          THEN ROUND(GREATEST(0, 1.0 - avg_response_hours / 168.0)::numeric, 4)
          ELSE 0
        END                                         AS response_time_score,
        -- WEIGHTED SCORE: Score = (ResRate × 0.6) + (RespScore × 0.4)
        ROUND((
          CASE WHEN total > 0 THEN (resolved::numeric / total) ELSE 0 END * 0.6
          +
          CASE WHEN avg_response_hours IS NOT NULL
            THEN GREATEST(0, 1.0 - avg_response_hours / 168.0) ELSE 0 END * 0.4
        )::numeric, 4)                              AS score
      FROM ward_stats
      ORDER BY score DESC, resolved DESC
    `);

        // Add rank + medals
        const ranked = rows.map((r, i) => ({
            rank: i + 1,
            medal: i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null,
            ...r,
            score: parseFloat(r.score),
            resolution_rate: parseFloat(r.resolution_rate),
            response_time_score: parseFloat(r.response_time_score),
        }));

        res.json({
            generated_at: new Date().toISOString(),
            formula: 'Score = (ResolutionRate × 0.6) + (AvgResponseTimeScore × 0.4)',
            rankings: ranked,
        });

    } catch (err) {
        res.status(500).json({ error: 'Failed to compute rankings', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/analytics/heatmap?category=all&days=90
   Returns [{lat, lon, value}] for heatmap.js
   value = supporter_count (heat intensity)
   ═══════════════════════════════════════════════════════════════ */
router.get('/analytics/heatmap', async (req, res) => {
    const { category = 'all', days = 90 } = req.query;
    try {
        const params = [parseInt(days)];
        const catFilter = category !== 'all'
            ? `AND r.category = $${params.push(category)}`
            : '';

        const { rows } = await pool.query(
            `SELECT
               r.gps_lat   AS lat,
               r.gps_lon   AS lon,
               r.supporter_count AS value,
               r.category,
               r.state,
               r.id
             FROM reports r
             WHERE r.gps_lat IS NOT NULL
               AND r.gps_lon IS NOT NULL
               AND r.parent_report_id IS NULL
               AND r.created_at > NOW() - ($1 || ' days')::INTERVAL
               ${catFilter}`,
            params
        );

        res.json({
            points: rows,
            count: rows.length,
            category,
            days: parseInt(days),
        });

    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch heatmap data', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/analytics/repeat-offenders?days=90&minCount=3
   Locations with ≥ N reports in the time window — infrastructure failure hotspots
   ═══════════════════════════════════════════════════════════════ */
router.get('/analytics/repeat-offenders', async (req, res) => {
    const { days = 90, minCount = 3 } = req.query;
    try {
        // Cluster within 50m using ST_DWithin — groups nearby reports
        const { rows } = await pool.query(
            `SELECT
               r.category,
               COUNT(*) AS incident_count,
               AVG(r.gps_lat) AS lat,
               AVG(r.gps_lon) AS lon,
               MAX(r.created_at) AS last_seen,
               MIN(r.created_at) AS first_seen,
               SUM(r.supporter_count) AS total_supporters,
               w.ward_name, w.zone
             FROM reports r
             LEFT JOIN city_wards w ON r.ward_id = w.ward_id
             WHERE r.gps_lat IS NOT NULL
               AND r.parent_report_id IS NULL
               AND r.created_at > NOW() - ($1 || ' days')::INTERVAL
             GROUP BY r.category, w.ward_name, w.zone,
               -- Spatial grid cell (approx 100m resolution at Delhi latitude)
               ROUND(r.gps_lat::numeric, 3),
               ROUND(r.gps_lon::numeric, 3)
             HAVING COUNT(*) >= $2
             ORDER BY incident_count DESC, total_supporters DESC`,
            [parseInt(days), parseInt(minCount)]
        );

        res.json({ hotspots: rows, count: rows.length, days: parseInt(days) });

    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch repeat offenders', detail: err.message });
    }
});

module.exports = router;
