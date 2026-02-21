/**
 * routes/chat.js — Per-Report Chat API
 *
 * GET  /api/reports/:id/chat  — Fetch messages for a report
 * POST /api/reports/:id/chat  — Post a new message
 */

const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

/* GET /api/reports/:id/chat */
router.get('/reports/:id/chat', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query(
            `SELECT id, report_id, sender_role, sender_name, message, sent_at
             FROM report_chat
             WHERE report_id = $1
             ORDER BY sent_at ASC
             LIMIT 200`,
            [id]
        );
        res.json({ messages: rows, count: rows.length });
    } catch (err) {
        console.error('[Chat] GET error:', err.message);
        res.status(500).json({ error: 'Failed to fetch chat', detail: err.message });
    }
});

/* POST /api/reports/:id/chat */
router.post('/reports/:id/chat', async (req, res) => {
    const { id } = req.params;
    const { sender_role = 'citizen', sender_name = 'Anonymous', message } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
    }
    if (!['citizen', 'authority', 'system'].includes(sender_role)) {
        return res.status(400).json({ error: 'sender_role must be citizen | authority | system' });
    }

    try {
        // Verify report exists
        const { rows: rr } = await pool.query('SELECT id FROM reports WHERE id = $1', [id]);
        if (!rr.length) return res.status(404).json({ error: `Report #${id} not found` });

        const { rows } = await pool.query(
            `INSERT INTO report_chat (report_id, sender_role, sender_name, message)
             VALUES ($1, $2, $3, $4)
             RETURNING id, report_id, sender_role, sender_name, message, sent_at`,
            [id, sender_role, sender_name.slice(0, 100), message.trim().slice(0, 1000)]
        );

        // Broadcast to SSE clients
        if (global.sseClients) {
            const evt = JSON.stringify({ type: 'chat', reportId: parseInt(id), msg: rows[0] });
            global.sseClients.forEach(c => c.write(`data: ${evt}\n\n`));
        }

        res.status(201).json({ success: true, message: rows[0] });
    } catch (err) {
        console.error('[Chat] POST error:', err.message);
        res.status(500).json({ error: 'Failed to post message', detail: err.message });
    }
});

module.exports = router;
