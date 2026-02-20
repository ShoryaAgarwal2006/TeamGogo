/**
 * routes/reports.js — Spatial API Routes
 *
 * POST /api/reports  — Submit report → Point-in-Polygon → Dedup → Insert
 * GET  /api/reports  — List recent reports
 * GET  /api/wards    — Return ward boundaries as GeoJSON
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const pool = require('../db/pool');
const { sendSupportNotification } = require('./push');

const router = express.Router();

// ── Multer config for photo uploads ─────────────────────────
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
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max (images are pre-compressed by the Web Worker)
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    },
});

/* ═══════════════════════════════════════════════════════════
   POST /api/reports — The Spatial Pipeline
   ═══════════════════════════════════════════════════════════ */
router.post('/reports', upload.single('photo'), async (req, res) => {
    const client = await pool.connect();

    try {
        const { category, description, location, gpsLat, gpsLon, captureTimestamp } = req.body;
        const lat = parseFloat(gpsLat);
        const lon = parseFloat(gpsLon);

        // Validate required fields
        if (!category || !description) {
            return res.status(400).json({ error: 'category and description are required' });
        }

        const hasCoordinates = !isNaN(lat) && !isNaN(lon);
        const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

        await client.query('BEGIN');

        // ── Step 1: Point-in-Polygon — Find ward ──────────────────
        let ward = null;
        if (hasCoordinates) {
            const wardQuery = `
        SELECT ward_id, ward_name, zone, officer_name, officer_email, officer_phone
        FROM city_wards
        WHERE ST_Contains(
          ward_geometry,
          ST_SetSRID(ST_Point($1, $2), 4326)
        )
        LIMIT 1;
      `;
            const wardResult = await client.query(wardQuery, [lon, lat]);
            if (wardResult.rows.length > 0) {
                ward = wardResult.rows[0];
            }
        }

        // ── Step 2: Duplicate Detection (50m buffer) ──────────────
        let existingDuplicate = null;
        if (hasCoordinates) {
            const dedupQuery = `
        SELECT id, description, supporter_count, location_text,
               ST_Distance(
                 coordinates::geography,
                 ST_SetSRID(ST_Point($1, $2), 4326)::geography
               ) AS distance_m
        FROM reports
        WHERE category = $3
          AND status = 'active'
          AND parent_report_id IS NULL
          AND ST_DWithin(
            coordinates::geography,
            ST_SetSRID(ST_Point($1, $2), 4326)::geography,
            50
          )
        ORDER BY created_at ASC
        LIMIT 1;
      `;
            const dedupResult = await client.query(dedupQuery, [lon, lat, category]);
            if (dedupResult.rows.length > 0) {
                existingDuplicate = dedupResult.rows[0];
            }
        }

        let reportId;
        let isDuplicate = false;
        let supporterCount = 1;
        let parentReportId = null;

        if (existingDuplicate) {
            // ── Step 3a: Merge — Insert as child report ─────────────
            isDuplicate = true;
            parentReportId = existingDuplicate.id;

            const insertChild = `
        INSERT INTO reports (
          category, description, location_text, coordinates,
          ward_id, image_url, gps_lat, gps_lon, capture_timestamp,
          parent_report_id, status
        ) VALUES (
          $1, $2, $3,
          ${hasCoordinates ? "ST_SetSRID(ST_Point($4, $5), 4326)" : "NULL"},
          $6, $7, $8, $9, $10, $11, 'merged'
        )
        RETURNING id;
      `;
            const childValues = [
                category,
                description,
                location || null,
                ...(hasCoordinates ? [lon, lat] : [null, null]),
                ward?.ward_id || null,
                imageUrl,
                hasCoordinates ? lat : null,
                hasCoordinates ? lon : null,
                captureTimestamp || null,
                parentReportId,
            ];
            const childResult = await client.query(insertChild, childValues);
            reportId = childResult.rows[0].id;

            // Bump supporter_count on parent
            const bumpQuery = `
        UPDATE reports
        SET supporter_count = supporter_count + 1
        WHERE id = $1
        RETURNING supporter_count;
      `;
            const bumpResult = await client.query(bumpQuery, [parentReportId]);
            supporterCount = bumpResult.rows[0].supporter_count;

        } else {
            // ── Step 3b: New report — Insert as standalone ──────────
            const insertNew = `
        INSERT INTO reports (
          category, description, location_text, coordinates,
          ward_id, image_url, gps_lat, gps_lon, capture_timestamp
        ) VALUES (
          $1, $2, $3,
          ${hasCoordinates ? "ST_SetSRID(ST_Point($4, $5), 4326)" : "NULL"},
          $6, $7, $8, $9, $10
        )
        RETURNING id;
      `;
            const newValues = [
                category,
                description,
                location || null,
                ...(hasCoordinates ? [lon, lat] : [null, null]),
                ward?.ward_id || null,
                imageUrl,
                hasCoordinates ? lat : null,
                hasCoordinates ? lon : null,
                captureTimestamp || null,
            ];
            const newResult = await client.query(insertNew, newValues);
            reportId = newResult.rows[0].id;
        }

        await client.query('COMMIT');

        // ── Push Notification (fire-and-forget, after commit) ─────
        // Notifies the original reporter: "Another neighbor supported your report!"
        if (isDuplicate && parentReportId) {
            sendSupportNotification(parentReportId, supporterCount);
        }

        // ── Response ──────────────────────────────────────────────
        const response = {
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
                    : `📋 Report submitted. Could not determine ward from coordinates.`,
        };

        console.log(
            `[API] Report #${reportId} | ${category} | ` +
            `Ward: ${ward?.ward_name || 'Unknown'} | ` +
            `Duplicate: ${isDuplicate} | Supporters: ${supporterCount}`
        );

        res.status(201).json(response);

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
        const { limit = 50, status = 'active' } = req.query;

        const query = `
      SELECT r.id, r.category, r.description, r.location_text,
             r.gps_lat, r.gps_lon, r.status, r.supporter_count,
             r.parent_report_id, r.image_url, r.created_at,
             w.ward_name, w.officer_name
      FROM reports r
      LEFT JOIN city_wards w ON r.ward_id = w.ward_id
      WHERE ($1 = 'all' OR r.status = $1)
      ORDER BY r.created_at DESC
      LIMIT $2;
    `;
        const result = await pool.query(query, [status, parseInt(limit)]);
        res.json({ reports: result.rows, count: result.rows.length });

    } catch (err) {
        console.error('[API] GET /reports error:', err);
        res.status(500).json({ error: 'Failed to fetch reports', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   GET /api/wards — Ward boundaries as GeoJSON FeatureCollection
   ═══════════════════════════════════════════════════════════ */
router.get('/wards', async (req, res) => {
    try {
        const query = `
      SELECT ward_id, ward_name, zone, officer_name, officer_email,
             ST_AsGeoJSON(ward_geometry)::json AS geometry
      FROM city_wards
      ORDER BY ward_id;
    `;
        const result = await pool.query(query);

        const geojson = {
            type: 'FeatureCollection',
            features: result.rows.map((row) => ({
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
        };

        res.json(geojson);

    } catch (err) {
        console.error('[API] GET /wards error:', err);
        res.status(500).json({ error: 'Failed to fetch wards', detail: err.message });
    }
});

module.exports = router;

/* ════════════════════════════════════════════════════════
   PATCH /api/reports/:id/status — Officer status update
   Body: { status: 'in_progress' | 'resolved' }
   ════════════════════════════════════════════════════════ */
router.patch('/reports/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const VALID_STATUSES = ['active', 'in_progress', 'resolved'];
    if (!status || !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
            error: `status must be one of: ${VALID_STATUSES.join(', ')}`,
        });
    }

    try {
        const query = `
      UPDATE reports
      SET status = $1
      WHERE id = $2
      RETURNING id, category, description, status, ward_id, supporter_count, updated_at;
    `;
        const result = await pool.query(query, [status, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: `Report #${id} not found` });
        }

        const updated = result.rows[0];
        console.log(`[API] Report #${id} status updated to '${status}'`);

        res.json({
            success: true,
            report: updated,
            message: `✅ Report #${id} status updated to '${status}'`,
        });

    } catch (err) {
        console.error('[API] PATCH /reports/:id/status error:', err);
        res.status(500).json({ error: 'Failed to update status', detail: err.message });
    }
});

module.exports = router;
