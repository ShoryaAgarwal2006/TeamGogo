/**
 * server/index.js — CivicPulse Express Server (Phase 5)
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pool = require('./db/pool');

/* ── Auto-migration: runs schema + seed on every cold start ── */
async function runMigrations() {
    const schemaFile = path.join(__dirname, 'db', 'schema_v5.sql');
    const seedFile = path.join(__dirname, 'db', 'seed.sql');
    const client = await pool.connect();
    try {
        console.log('[DB] Running schema migration…');
        const schema = fs.readFileSync(schemaFile, 'utf8');
        await client.query(schema);
        console.log('[DB] Schema OK');

        // Only seed if city_wards table is empty
        const { rows } = await client.query('SELECT COUNT(*) AS n FROM city_wards');
        if (parseInt(rows[0].n) === 0) {
            console.log('[DB] Seeding ward data…');
            const seed = fs.readFileSync(seedFile, 'utf8');
            await client.query(seed);
            console.log('[DB] Seed OK');
        } else {
            console.log('[DB] Ward data already present — skipping seed');
        }
    } catch (err) {
        console.error('[DB] Migration error:', err.message);
    } finally {
        client.release();
    }
}

const reportsRouter = require('./routes/reports');
const pushRouter = require('./routes/push');
const workflowRouter = require('./routes/workflow');
const analyticsRouter = require('./routes/analytics');
const chatRouter = require('./routes/chat');
const verifyRouter = require('./routes/verify');
const liveRouter = require('./routes/live');
const { startCron } = require('./lib/escalation');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded images
app.use('/uploads', express.static(uploadDir));

// Serve PWA (parent directory)
const pwaRoot = path.join(__dirname, '..');
app.use(express.static(pwaRoot, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Service-Worker-Allowed', '/');
        }
        // Never cache JS/HTML so browsers always get fresh code
        if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    },
}));

// ── API Routes ────────────────────────────────────────────────
app.use('/api', liveRouter);        // SSE live feed (register first — no body parsing)
app.use('/api', reportsRouter);     // Phase 2+ spatial reports
app.use('/api', workflowRouter);    // Phase 3+: transitions, dashboard, ward performance
app.use('/api', analyticsRouter);   // Phase 4: proof, votes, rankings, heatmap
app.use('/api/push', pushRouter);
app.use('/api', chatRouter);        // Phase 5: per-report chat
app.use('/api', verifyRouter);      // Phase 5: citizen verification

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        phase: 5,
        sse_clients: global.sseClients ? global.sseClients.size : 0,
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('[Server] Error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// Start — run migrations first, then listen
(async () => {
    await runMigrations();
    app.listen(PORT, () => {
        console.log(`\n🏛️  CivicPulse Phase 5 server running at http://localhost:${PORT}`);
        console.log(`   • PWA:          http://localhost:${PORT}/`);
        console.log(`   • Dashboard:    http://localhost:${PORT}/dashboard.html`);
        console.log(`   • Live Tracking:http://localhost:${PORT}/tracking.html`);
        console.log(`   • API:          http://localhost:${PORT}/api/\n`);
        startCron();
    });
})();
