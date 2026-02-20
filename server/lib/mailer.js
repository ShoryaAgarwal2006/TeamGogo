/**
 * lib/mailer.js — CivicPulse Email Sender
 *
 * Uses nodemailer with:
 *  • Production: SMTP via env vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)
 *  • Development fallback: Ethereal auto-account (preview URL printed to terminal)
 */

const nodemailer = require('nodemailer');

let _transporter = null;

async function getTransporter() {
    if (_transporter) return _transporter;

    if (process.env.SMTP_HOST) {
        // Production SMTP
        _transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
        console.log('[Mailer] Using production SMTP:', process.env.SMTP_HOST);
    } else {
        // Dev fallback — Ethereal test account (no real emails sent)
        const testAccount = await nodemailer.createTestAccount();
        _transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: { user: testAccount.user, pass: testAccount.pass },
        });
        console.log('[Mailer] ⚠️  No SMTP configured — using Ethereal test account');
        console.log('[Mailer]   User:', testAccount.user);
    }

    return _transporter;
}

// ── SLA level labels ──────────────────────────────────────────
const LEVEL_LABELS = {
    1: { label: 'LEVEL 1 — Junior Engineer Alert', urgency: '⚠️', color: '#f59e0b' },
    2: { label: 'LEVEL 2 — Executive Engineer Escalation', urgency: '🔴', color: '#ef4444' },
    3: { label: 'LEVEL 3 — Commissioner Weekly Report', urgency: '🚨', color: '#7c3aed' },
};

/**
 * sendEscalationEmail({ level, report, recipient, recipientName })
 * Returns { success, messageId, previewUrl? }
 */
async function sendEscalationEmail({ level, report, recipient, recipientName }) {
    const transport = await getTransporter();
    const meta = LEVEL_LABELS[level] || LEVEL_LABELS[1];
    const hoursElapsed = report.assigned_at
        ? Math.floor((Date.now() - new Date(report.assigned_at).getTime()) / 3_600_000)
        : '—';

    const subject = `${meta.urgency} CivicPulse SLA Breach — Report #${report.id} [${report.category}] — ${meta.label}`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:Inter,Arial,sans-serif;color:#e2e8f0;">
  <div style="max-width:600px;margin:32px auto;background:#1e293b;border-radius:16px;border:1px solid ${meta.color}44;overflow:hidden;">
    
    <div style="background:linear-gradient(135deg,${meta.color}33,transparent);padding:32px;border-bottom:1px solid ${meta.color}44;">
      <div style="font-size:2.5rem;margin-bottom:8px;">${meta.urgency}</div>
      <h1 style="margin:0;font-size:1.4rem;color:#fff;">${meta.label}</h1>
      <p style="margin:8px 0 0;font-size:0.9rem;color:#94a3b8;">CivicPulse Accountability Engine — Automated SLA Alert</p>
    </div>

    <div style="padding:32px;">
      <p style="margin:0 0 24px;">Dear ${recipientName || 'Officer'},</p>
      <p style="margin:0 0 24px;line-height:1.6;">
        Report <strong style="color:${meta.color};">#${report.id}</strong> has breached the SLA threshold 
        after <strong>${hoursElapsed} hours</strong> without resolution. Immediate action is required.
      </p>

      <div style="background:#0f172a;border-radius:12px;padding:24px;border:1px solid #334155;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;width:140px;">Report ID</td>
              <td style="padding:8px 0;font-weight:600;color:${meta.color};">#${report.id}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;">Category</td>
              <td style="padding:8px 0;font-weight:600;text-transform:capitalize;">${report.category}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;">State</td>
              <td style="padding:8px 0;"><span style="background:${meta.color}22;color:${meta.color};padding:3px 10px;border-radius:99px;font-size:0.8rem;font-weight:700;">${report.state}</span></td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;">Location</td>
              <td style="padding:8px 0;">${report.location_text || 'GPS coordinates on file'}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;">Ward</td>
              <td style="padding:8px 0;">${report.ward_name || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;">Hours Elapsed</td>
              <td style="padding:8px 0;"><strong style="color:#ef4444;">${hoursElapsed} hours</strong></td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;">Supporters</td>
              <td style="padding:8px 0;">${report.supporter_count} citizen(s)</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:0.85rem;">Description</td>
              <td style="padding:8px 0;color:#94a3b8;font-size:0.9rem;">${(report.description || '').slice(0, 200)}</td></tr>
        </table>
      </div>

      <div style="background:#ef444411;border:1px solid #ef444444;border-radius:8px;padding:16px;margin-bottom:24px;">
        <strong style="color:#ef4444;">⏰ Required Action:</strong>
        <p style="margin:8px 0 0;font-size:0.9rem;line-height:1.6;">
          ${level === 1 ? 'Please update the ticket status and begin field inspection within 48 hours.' : ''}
          ${level === 2 ? 'This issue has been unresolved for 5+ days. Immediate escalation and field visit required.' : ''}
          ${level === 3 ? 'This report appears in the Weekly Pending Report for the Commissioner\'s office. Resolution must be provided in the weekly status meeting.' : ''}
        </p>
      </div>

      <a href="http://localhost:3000/dashboard.html" 
         style="display:inline-block;background:linear-gradient(135deg,${meta.color},${meta.color}cc);color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:0.9rem;">
        🗺️ View Dashboard
      </a>
    </div>

    <div style="padding:16px 32px;border-top:1px solid #334155;color:#475569;font-size:0.75rem;">
      CivicPulse Accountability Engine · Automated SLA Enforcement · Do not reply to this email
    </div>
  </div>
</body>
</html>`;

    try {
        const info = await transport.sendMail({
            from: `"CivicPulse 🏛️" <${process.env.SMTP_FROM || 'noreply@civicpulse.gov.in'}>`,
            to: recipient,
            subject,
            html,
        });

        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) {
            console.log(`[Mailer] 📧 L${level} email preview: ${previewUrl}`);
        }

        return { success: true, messageId: info.messageId, previewUrl };

    } catch (err) {
        console.error('[Mailer] Failed to send email:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = { sendEscalationEmail };
