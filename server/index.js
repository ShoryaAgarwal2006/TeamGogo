/**
 * server/index.js — CivicPulse Express Server
 *
 * Serves the Phase 1 PWA static files AND the Phase 2 spatial API
 * from the same origin so the Service Worker scope stays valid.
 * Phase 3: Accountability Engine — state machine + SLA escalation cron.
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const reportsRouter = require('./routes/reports');
const pushRouter = require('./routes/push');
const workflowRouter = require('./routes/workflow');
const analyticsRouter = require('./routes/analytics');
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

// Serve PWA (parent directory) — keeps SW scope valid
const pwaRoot = path.join(__dirname, '..');
app.use(express.static(pwaRoot, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Service-Worker-Allowed', '/');
        }
    },
}));

// API Routes
app.use('/api', reportsRouter);
app.use('/api', workflowRouter);     // Phase 3: PATCH transition, GET dashboard, GET weekly-pending
app.use('/api', analyticsRouter);    // Phase 4: proof, votes, rankings, heatmap, feed
app.use('/api/push', pushRouter);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), phase: 4 });
});

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(pwaRoot, 'index.html'));
    }
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('[Server] Error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// Start
app.listen(PORT, () => {
    console.log(`\n🏛️  CivicPulse server running at http://localhost:${PORT}`);
    console.log(`   • PWA:        http://localhost:${PORT}/`);
    console.log(`   • Dashboard:  http://localhost:${PORT}/dashboard.html`);
    console.log(`   • API:        http://localhost:${PORT}/api/`);
    console.log(`   • Phase 3: Accountability Engine active\n`);

    // Start SLA escalation cron (runs every 15 min + immediate first check)
    startCron();
});
