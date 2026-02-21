/**
 * routes/reports.js — Spatial API Routes (Phase 5 Update)
 *
 * POST /api/reports       — Submit report (GPS mandatory) → Point-in-Polygon → Dedup → Insert
 * GET  /api/reports       — List recent reports
 * GET  /api/reports/nearby — Nearby reports by GPS radius
 * GET  /api/wards         — Ward boundaries as GeoJSON
 * GET  /api/emergency-alerts — High-priority / emergency reports
 * PATCH /api/reports/:id/status — Officer status update
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const pool = require('../db/pool');
const { sendSupportNotification } = require('./push');

const router = express.Router();

// ── Multer config ────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
    filename: (req, file, cb) => {
        const ts = Date.now();
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `report-${ts}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    },
});

/* ═══════════════════════════════════════════════════════════
   POST /api/reports — Spatial Pipeline (GPS Mandatory)
   ═══════════════════════════════════════════════════════════ */
router.post('/reports', upload.single('photo'), async (req, res) => {
    const client = await pool.connect();
    try {
        const {
            category, description, location,
            location_detail,
            gpsLat, gpsLon, captureTimestamp,
            severity_level = 'medium', reporter_token,
        } = req.body;

        const lat = parseFloat(gpsLat);
        const lon = parseFloat(gpsLon);

        // Combine GPS address + optional free-text detail into one location string
        const locationText = location_detail && location_detail.trim()
            ? `${location || ''} — ${location_detail.trim()}`.trim().replace(/^— /, '')
            : (location || null);

        // Validate required fields
        if (!category || !description) {
            return res.status(400).json({ error: 'category and description are required' });
        }
        if (isNaN(lat) || isNaN(lon)) {
            return res.status(400).json({ error: 'GPS coordinates (gpsLat, gpsLon) are required' });
        }

        const validSeverity = ['low', 'medium', 'high', 'critical'].includes(severity_level)
            ? severity_level : 'medium';
        const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

        await client.query('BEGIN');

        // ── Step 1: Point-in-Polygon ──────────────────────────────
        const wardResult = await client.query(`
            SELECT ward_id, ward_name, zone, officer_name, officer_email, officer_phone
            FROM city_wards
            WHERE ST_Contains(ward_geometry, ST_SetSRID(ST_Point($1, $2), 4326))
            LIMIT 1
        `, [lon, lat]);
        const ward = wardResult.rows[0] || null;

        // ── Step 2: Duplicate Detection (50m buffer) ──────────────
        const dedupResult = await client.query(`
            SELECT id, description, supporter_count, location_text,
                   ST_Distance(
                     coordinates::geography,
                     ST_SetSRID(ST_Point($1, $2), 4326)::geography
                   ) AS distance_m
            FROM reports
            WHERE category = $3
              AND state NOT IN ('RESOLVED', 'MERGED')
              AND parent_report_id IS NULL
              AND ST_DWithin(
                coordinates::geography,
                ST_SetSRID(ST_Point($1, $2), 4326)::geography,
                50
              )
            ORDER BY created_at ASC
            LIMIT 1
        `, [lon, lat, category]);
        const existingDuplicate = dedupResult.rows[0] || null;

        let reportId, isDuplicate = false, supporterCount = 1, parentReportId = null;

        if (existingDuplicate) {
            // ── Step 3a: Merge ────────────────────────────────────
            isDuplicate = true;
            parentReportId = existingDuplicate.id;

            const childResult = await client.query(`
                INSERT INTO reports (
                    category, description, location_text, coordinates,
                    ward_id, image_url, gps_lat, gps_lon, capture_timestamp,
                    parent_report_id, state, status, severity_level, reporter_token
                ) VALUES (
                    $1, $2, $3,
                    ST_SetSRID(ST_Point($4, $5), 4326),
                    $6, $7, $8, $9, $10, $11, 'MERGED', 'merged', $12, $13
                )
                RETURNING id
            `, [
                category, description, locationText,
                lon, lat,
                ward?.ward_id || null, imageUrl,
                lat, lon,
                captureTimestamp || null,
                parentReportId,
                validSeverity, reporter_token || null,
            ]);
            reportId = childResult.rows[0].id;

            const bumpResult = await client.query(`
                UPDATE reports SET supporter_count = supporter_count + 1 WHERE id = $1
                RETURNING supporter_count
            `, [parentReportId]);
            supporterCount = bumpResult.rows[0].supporter_count;

        } else {
            // ── Step 3b: New report ───────────────────────────────
            const newResult = await client.query(`
                INSERT INTO reports (
                    category, description, location_text, coordinates,
                    ward_id, image_url, gps_lat, gps_lon, capture_timestamp,
                    severity_level, reporter_token
                ) VALUES (
                    $1, $2, $3,
                    ST_SetSRID(ST_Point($4, $5), 4326),
                    $6, $7, $8, $9, $10, $11, $12
                )
                RETURNING id
            `, [
                category, description, locationText,
                lon, lat,
                ward?.ward_id || null, imageUrl,
                lat, lon,
                captureTimestamp || null,
                validSeverity, reporter_token || null,
            ]);
            reportId = newResult.rows[0].id;
        }

        await client.query('COMMIT');

        // Push notification (fire-and-forget)
        if (isDuplicate && parentReportId) {
            sendSupportNotification(parentReportId, supporterCount);
        }

        // Broadcast SSE update
        if (global.sseClients && global.sseClients.size > 0) {
            const { broadcastReports } = req.app.get('liveBroadcast') || {};
            if (broadcastReports) broadcastReports();
        }

        res.status(201).json({
            success: true,
            reportId,
            isDuplicate,
            parentReportId,
            supporterCount,
            ward: ward ? {
                wardId: ward.ward_id,
                wardName: ward.ward_name,
                zone: ward.zone,
                officerName: ward.officer_name,
                officerEmail: ward.officer_email,
                officerPhone: ward.officer_phone,
            } : null,
            message: isDuplicate
                ? `🤝 Another neighbor already reported this! ${supporterCount} people now support this report.`
                : ward
                    ? `📍 Report routed to ${ward.ward_name} ward — Officer ${ward.officer_name} has been notified.`
                    : `📋 Report submitted. Location recorded at ${lat.toFixed(4)}°, ${lon.toFixed(4)}°.`,
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[API] POST /reports error:', err);
        res.status(500).json({ error: 'Failed to submit report', detail: err.message });
    } finally {
        client.release();
    }
});

/* ═══════════════════════════════════════════════════════════
   GET /api/reports — List recent reports
   ═══════════════════════════════════════════════════════════ */
router.get('/reports', async (req, res) => {
    try {
        const { limit = 50, state } = req.query;
        const stateFilter = state ? `AND r.state = '${state}'` : '';

        const { rows } = await pool.query(`
            SELECT r.id, r.category, r.description, r.location_text,
                   r.gps_lat, r.gps_lon, r.state, r.status, r.supporter_count,
                   r.severity_level, r.is_emergency, r.verification_count,
                   r.parent_report_id, r.image_url, r.created_at, r.sla_level,
                   w.ward_name, w.officer_name
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.parent_report_id IS NULL
              ${stateFilter}
            ORDER BY r.is_emergency DESC, r.created_at DESC
            LIMIT $1
        `, [parseInt(limit)]);

        res.json({ reports: rows, count: rows.length });
    } catch (err) {
        console.error('[API] GET /reports error:', err);
        res.status(500).json({ error: 'Failed to fetch reports', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   GET /api/reports/my?token=<reporter_token>
   Returns reports submitted by this reporter
   ═══════════════════════════════════════════════════════════ */
router.get('/reports/my', async (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).json({ error: 'token query parameter is required' });
    }
    try {
        const { rows } = await pool.query(`
            SELECT r.id, r.category, r.description, r.location_text,
                   r.gps_lat, r.gps_lon, r.state, r.status, r.supporter_count,
                   r.severity_level, r.is_emergency, r.verification_count,
                   r.parent_report_id, r.image_url, r.created_at, r.updated_at,
                   r.sla_level,
                   w.ward_name, w.zone, w.officer_name, w.officer_email
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.reporter_token = $1
            ORDER BY r.created_at DESC
            LIMIT 50
        `, [token]);

        res.json({ reports: rows, count: rows.length });
    } catch (err) {
        console.error('[API] GET /reports/my error:', err);
        res.status(500).json({ error: 'Failed to fetch your reports', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   GET /api/reports/nearby?lat=&lon=&radius=500
   Returns reports within radius metres, ordered by distance
   ═══════════════════════════════════════════════════════════ */
router.get('/reports/nearby', async (req, res) => {
    const { lat, lon, radius = 500 } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ error: 'lat and lon are required' });
    }
    const userLat = parseFloat(lat);
    const userLon = parseFloat(lon);
    const radiusM = Math.min(parseInt(radius) || 500, 5000); // cap at 5km

    try {
        const { rows } = await pool.query(`
            SELECT
                r.id, r.category, r.description, r.location_text,
                r.gps_lat, r.gps_lon, r.state, r.severity_level,
                r.is_emergency, r.supporter_count, r.verification_count,
                r.image_url, r.created_at, r.sla_level,
                w.ward_name, w.officer_name,
                ST_Distance(
                    coordinates::geography,
                    ST_SetSRID(ST_Point($2, $1), 4326)::geography
                ) AS distance_m
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.parent_report_id IS NULL
              AND r.state NOT IN ('MERGED', 'RESOLVED')
              AND coordinates IS NOT NULL
              AND ST_DWithin(
                coordinates::geography,
                ST_SetSRID(ST_Point($2, $1), 4326)::geography,
                $3
              )
            ORDER BY distance_m ASC
            LIMIT 30
        `, [userLat, userLon, radiusM]);

        res.json({ reports: rows, count: rows.length, radius_m: radiusM });
    } catch (err) {
        console.error('[API] GET /reports/nearby error:', err);
        res.status(500).json({ error: 'Failed to fetch nearby reports', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   GET /api/emergency-alerts — High-priority emergency reports
   ═══════════════════════════════════════════════════════════ */
router.get('/emergency-alerts', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT r.id, r.category, r.description, r.location_text,
                   r.gps_lat, r.gps_lon, r.state, r.severity_level,
                   r.supporter_count, r.verification_count, r.sla_level,
                   r.is_emergency, r.created_at,
                   w.ward_name, w.zone, w.officer_name
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.is_emergency = TRUE
              AND r.state NOT IN ('RESOLVED', 'MERGED')
              AND r.parent_report_id IS NULL
            ORDER BY r.sla_level DESC, r.supporter_count DESC, r.created_at ASC
            LIMIT 20
        `);

        res.json({ alerts: rows, count: rows.length });
    } catch (err) {
        console.error('[API] GET /emergency-alerts error:', err);
        res.status(500).json({ error: 'Failed to fetch emergency alerts', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   GET /api/wards — Ward boundaries as GeoJSON FeatureCollection
   ═══════════════════════════════════════════════════════════ */
router.get('/wards', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT ward_id, ward_name, zone, officer_name, officer_email,
                   ST_AsGeoJSON(ward_geometry)::json AS geometry
            FROM city_wards ORDER BY ward_id
        `);

        res.json({
            type: 'FeatureCollection',
            features: rows.map(row => ({
                type: 'Feature',
                properties: {
                    wardId: row.ward_id,
                    wardName: row.ward_name,
                    zone: row.zone,
                    officerName: row.officer_name,
                    officerEmail: row.officer_email,
                },
                geometry: row.geometry,
            })),
        });
    } catch (err) {
        console.error('[API] GET /wards error:', err);
        res.status(500).json({ error: 'Failed to fetch wards', detail: err.message });
    }
});

/* ════════════════════════════════════════════════════════
   PATCH /api/reports/:id/status — Quick status update
   ════════════════════════════════════════════════════════ */
router.patch('/reports/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const VALID = ['active', 'in_progress', 'resolved'];
    if (!status || !VALID.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    }
    try {
        const { rows } = await pool.query(
            `UPDATE reports SET status = $1 WHERE id = $2
             RETURNING id, category, description, status, ward_id, supporter_count, updated_at`,
            [status, id]
        );
        if (!rows.length) return res.status(404).json({ error: `Report #${id} not found` });
        res.json({ success: true, report: rows[0], message: `✅ Report #${id} status updated to '${status}'` });
    } catch (err) {
        console.error('[API] PATCH /reports/:id/status error:', err);
        res.status(500).json({ error: 'Failed to update status', detail: err.message });
    }
});

module.exports = router;
