/**
 * lib/stateMachine.js — CivicPulse Workflow State Machine
 *
 * Strictly defines valid state transitions and enforces guards.
 *
 * States:
 *   SUBMITTED → VERIFIED → ASSIGNED → IN_PROGRESS → RESOLVED
 *   Any state → MERGED (when report is a duplicate)
 *
 * Guards:
 *   IN_PROGRESS requires officer to be within 100m of the report's GPS location
 */

const pool = require('../db/pool');

// ── Transition map ────────────────────────────────────────────
// Key: current state → Value: allowed next states
const TRANSITIONS = {
    SUBMITTED: ['VERIFIED'],
    VERIFIED: ['ASSIGNED'],
    ASSIGNED: ['IN_PROGRESS'],
    IN_PROGRESS: ['RESOLVED'],
    RESOLVED: [],
    MERGED: [],
};

// ── Timestamp column written per transition ───────────────────
const STATE_TIMESTAMP = {
    VERIFIED: 'verified_at',
    ASSIGNED: 'assigned_at',
    IN_PROGRESS: 'in_progress_at',
};

// ── Haversine distance (metres) ───────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6_371_000; // Earth radius in metres
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * canTransition(fromState, toState)
 * Returns { allowed: true } or { allowed: false, reason: '...' }
 */
function canTransition(fromState, toState) {
    const allowed = TRANSITIONS[fromState] ?? [];
    if (!allowed.includes(toState)) {
        return {
            allowed: false,
            reason: `Transition ${fromState}→${toState} is not allowed. Valid next states: [${allowed.join(', ') || 'none'}]`,
        };
    }
    return { allowed: true };
}

/**
 * applyTransition(reportId, toState, metadata)
 *
 * metadata: {
 *   officerLat?   — number  (required for IN_PROGRESS guard)
 *   officerLon?   — number
 *   officerEmail? — string  (stored when ASSIGNED)
 *   officerPhone? — string
 * }
 *
 * Returns: { success, report, transition: { from, to }, error? }
 */
async function applyTransition(reportId, toState, metadata = {}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Fetch current report state
        const { rows } = await client.query(
            `SELECT id, state, gps_lat, gps_lon, category, description,
                    location_text, ward_id, assigned_officer_email
             FROM reports WHERE id = $1 FOR UPDATE`,
            [reportId]
        );

        if (!rows.length) {
            throw Object.assign(new Error(`Report #${reportId} not found`), { status: 404 });
        }

        const report = rows[0];
        const fromState = report.state;

        // 1. Check transition is valid
        const check = canTransition(fromState, toState);
        if (!check.allowed) {
            throw Object.assign(new Error(check.reason), { status: 409 });
        }

        // 2. Geo-fence guard for IN_PROGRESS
        if (toState === 'IN_PROGRESS') {
            const { officerLat, officerLon } = metadata;
            if (officerLat == null || officerLon == null) {
                throw Object.assign(
                    new Error('Officer GPS coordinates are required to start IN_PROGRESS'),
                    { status: 400 }
                );
            }
            if (report.gps_lat == null || report.gps_lon == null) {
                throw Object.assign(
                    new Error('Report has no GPS coordinates — cannot verify officer proximity'),
                    { status: 422 }
                );
            }
            const dist = haversineDistance(
                parseFloat(officerLat), parseFloat(officerLon),
                report.gps_lat, report.gps_lon
            );
            if (dist > 100) {
                throw Object.assign(
                    new Error(
                        `Officer must be within 100m of the issue location. Current distance: ${dist.toFixed(0)}m`
                    ),
                    { status: 403, distanceMetres: dist }
                );
            }
        }

        // 3. Build SET clause
        const tsCol = STATE_TIMESTAMP[toState];
        const setClauses = ['state = $2'];
        const values = [reportId, toState];
        let paramIdx = 3;

        if (tsCol) {
            setClauses.push(`${tsCol} = NOW()`);
        }
        if (toState === 'ASSIGNED' && metadata.officerEmail) {
            setClauses.push(`assigned_officer_email = $${paramIdx++}`);
            values.push(metadata.officerEmail);
        }
        if (toState === 'ASSIGNED' && metadata.officerPhone) {
            setClauses.push(`assigned_officer_phone = $${paramIdx++}`);
            values.push(metadata.officerPhone);
        }

        // 4. Apply
        const updateSql = `
      UPDATE reports
      SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING *;
    `;
        const updated = await client.query(updateSql, values);

        await client.query('COMMIT');

        console.log(`[StateMachine] Report #${reportId}: ${fromState} → ${toState}`);

        return {
            success: true,
            transition: { from: fromState, to: toState },
            report: updated.rows[0],
        };

    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { canTransition, applyTransition, haversineDistance, TRANSITIONS };
