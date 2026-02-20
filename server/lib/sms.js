/**
 * lib/sms.js — CivicPulse SMS Sender
 *
 * Production: Twilio (if TWILIO_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM are set)
 * Development: Console mock — logs message, never crashes
 */

let twilioClient = null;

function getTwilioClient() {
    if (twilioClient) return twilioClient;
    const sid = process.env.TWILIO_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (sid && token) {
        try {
            twilioClient = require('twilio')(sid, token);
            console.log('[SMS] Twilio client initialized');
        } catch {
            console.warn('[SMS] twilio package not installed — falling back to mock');
        }
    }
    return twilioClient;
}

/**
 * sendSMS(to, body)
 * Returns { success, sid? } or { success: false, mock: true }
 */
async function sendSMS(to, body) {
    const client = getTwilioClient();

    if (!client || !process.env.TWILIO_FROM) {
        // Mock mode — safe for dev/demo, no crash
        console.log('┌──────────────────────────────────────────────────');
        console.log('│ [SMS MOCK] 📱 Would send to:', to);
        console.log('│ [SMS MOCK] 📝 Message:', body);
        console.log('└──────────────────────────────────────────────────');
        return { success: true, mock: true };
    }

    try {
        const msg = await client.messages.create({
            from: process.env.TWILIO_FROM,
            to,
            body,
        });
        console.log(`[SMS] Sent to ${to} — SID: ${msg.sid}`);
        return { success: true, sid: msg.sid };
    } catch (err) {
        console.error('[SMS] Failed:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * buildEscalationSMS(level, report)
 * Returns the SMS text for a given SLA level
 */
function buildEscalationSMS(level, report) {
    const hoursElapsed = report.assigned_at
        ? Math.floor((Date.now() - new Date(report.assigned_at).getTime()) / 3_600_000)
        : '?';

    const msgs = {
        2: `🔴 CivicPulse URGENT: Report #${report.id} (${report.category}) in ${report.ward_name || report.location_text || 'Unknown ward'} has been unresolved for ${hoursElapsed} hours. Immediate action required. View: http://civicpulse.local/dashboard.html`,
        3: `🚨 CivicPulse CRITICAL: Report #${report.id} (${report.category}) scheduled for Commissioner's weekly review. Pending ${hoursElapsed} hours. View: http://civicpulse.local/dashboard.html`,
    };

    return msgs[level] || `CivicPulse Alert: Report #${report.id} requires attention.`;
}

module.exports = { sendSMS, buildEscalationSMS };
