const nodemailer = require('nodemailer');
const { getSetting } = require('./db');

const recentEmailDedup = new Map();
let cachedTransporter = null;
let cachedTransporterKey = '';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getEmailConfig() {
  const to = process.env.ALERT_EMAIL_TO || process.env.EMAIL_TO || getSetting('alert_email_to') || '';
  const resendApiKey = process.env.RESEND_API_KEY || getSetting('resend_api_key') || '';
  const smtpHost = process.env.SMTP_HOST || getSetting('smtp_host') || 'smtp.gmail.com';
  const smtpPort = Number(process.env.SMTP_PORT || getSetting('smtp_port') || 465);
  const smtpUser = process.env.SMTP_USER || getSetting('smtp_user') || '';
  const smtpPass = process.env.SMTP_PASS || getSetting('smtp_pass') || '';
  const from = process.env.EMAIL_FROM || getSetting('email_from') || (resendApiKey ? 'Upwork Loom Alerts <onboarding@resend.dev>' : (smtpUser ? `Upwork Loom Alerts <${smtpUser}>` : ''));
  return { to: String(to).trim(), resendApiKey: String(resendApiKey).trim(), smtpHost: String(smtpHost).trim(), smtpPort, smtpUser: String(smtpUser).trim(), smtpPass: String(smtpPass).trim(), from: String(from).trim() };
}

function isEmailConfigured() {
  const cfg = getEmailConfig();
  return Boolean(cfg.to && (cfg.resendApiKey || (cfg.smtpUser && cfg.smtpPass)));
}

function getSmtpTransporter(cfg) {
  const key = `${cfg.smtpHost}:${cfg.smtpPort}:${cfg.smtpUser}:${cfg.smtpPass.slice(0, 4)}`;
  if (cachedTransporter && cachedTransporterKey === key) {
    return cachedTransporter;
  }
  cachedTransporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPass
    }
  });
  cachedTransporterKey = key;
  return cachedTransporter;
}

async function sendAlertEmail({ subject, html, text }) {
  const cfg = getEmailConfig();
  if (!cfg.to) {
    return { ok: false, skipped: 'no_recipient' };
  }

  // Prefer Resend HTTP API if configured
  if (cfg.resendApiKey) {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: cfg.from || 'Upwork Loom Alerts <onboarding@resend.dev>',
        to: [cfg.to],
        subject,
        html,
        text
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(`Resend HTTP ${resp.status}: ${JSON.stringify(data)}`);
    }
    return { ok: true, provider: 'resend', id: data.id };
  }

  // Fallback to SMTP via nodemailer (Gmail App Password / custom SMTP)
  if (cfg.smtpUser && cfg.smtpPass) {
    const transporter = getSmtpTransporter(cfg);
    const info = await transporter.sendMail({
      from: cfg.from || `Upwork Loom Alerts <${cfg.smtpUser}>`,
      to: cfg.to,
      subject,
      html,
      text
    });
    return { ok: true, provider: 'smtp', messageId: info.messageId };
  }

  return { ok: false, skipped: 'no_provider_configured' };
}

function detectDeviceSummary(userAgent = '') {
  const ua = String(userAgent);
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS/i.test(ua) ? 'macOS'
    : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari'
    : 'Browser';
  return `${browser} on ${os}`;
}

async function sendVideoWatchEmail({
  jobId,
  jobTitle,
  eventType,
  eventLabel,
  watchSeconds,
  visitorCountry,
  visitorCity,
  visitorRegion,
  visitorLocation,
  visitorTimezone,
  utcOffset,
  visitorIp,
  userAgent,
  shareUrl
}) {
  if (!isEmailConfigured()) {
    return { ok: false, skipped: 'email_not_configured' };
  }

  // Deduplicate identical (job, ip, eventType) bursts within 30s
  const dedupKey = `${jobId}|${visitorIp}|${eventType}`;
  const now = Date.now();
  const prev = recentEmailDedup.get(dedupKey) || 0;
  if (now - prev < 30000) {
    return { ok: false, skipped: 'dedup_30s' };
  }
  recentEmailDedup.set(dedupKey, now);
  if (recentEmailDedup.size > 500) {
    for (const [k, ts] of recentEmailDedup.entries()) {
      if (now - ts > 120000) recentEmailDedup.delete(k);
    }
  }

  const countryLabel = visitorCountry || visitorLocation || 'Unknown Country';
  const cleanJobId = String(jobId || '').trim().replace(/^~?02/, '');
  const upworkUrl = `https://www.upwork.com/jobs/~02${cleanJobId}`;
  const device = detectDeviceSummary(userAgent);
  const timestampTr = new Date(now + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' TR';

  const emojiMap = {
    page_open: '👀',
    video_play: '🎬',
    video_50pct: '🔥',
    video_completed: '🏆'
  };
  const icon = emojiMap[eventType] || '🎬';
  const subject = `${icon} Loom Video: ${eventLabel} (${countryLabel}) — ${String(jobTitle || cleanJobId).slice(0, 65)}`;

  const text = [
    `${icon} Client ${eventLabel}`,
    ``,
    `Job: ${jobTitle}`,
    `Country: ${countryLabel}`,
    `Location: ${visitorLocation}${utcOffset ? ` (${utcOffset})` : ''}`,
    `Timezone: ${visitorTimezone || 'N/A'}`,
    `Watch Duration: ${watchSeconds}s`,
    `Device: ${device}`,
    `IP: ${visitorIp || 'N/A'}`,
    `Time: ${timestampTr}`,
    ``,
    `Loom Link: ${shareUrl}`,
    `Upwork Job: ${upworkUrl}`
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#0f172a;color:#f8fafc;border-radius:12px;">
      <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#38bdf8;font-weight:700;margin-bottom:6px;">
        Upwork Loom Watch Alert
      </div>
      <h2 style="margin:0 0 16px 0;font-size:20px;color:#ffffff;">
        ${icon} Client ${escapeHtml(eventLabel)}
      </h2>
      <div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:16px;border:1px solid #334155;">
        <div style="font-size:16px;font-weight:700;color:#ffffff;margin-bottom:12px;">
          ${escapeHtml(jobTitle)}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#cbd5e1;">
          <tr><td style="padding:5px 0;color:#94a3b8;width:130px;">🌍 Country</td><td style="padding:5px 0;font-weight:600;color:#38bdf8;">${escapeHtml(countryLabel)}</td></tr>
          <tr><td style="padding:5px 0;color:#94a3b8;">📍 Location</td><td style="padding:5px 0;">${escapeHtml(visitorLocation)}${utcOffset ? ` (${escapeHtml(utcOffset)})` : ''}</td></tr>
          <tr><td style="padding:5px 0;color:#94a3b8;">⏱️ Watch Time</td><td style="padding:5px 0;font-weight:600;color:#4ade80;">${Number(watchSeconds || 0)}s</td></tr>
          <tr><td style="padding:5px 0;color:#94a3b8;">💻 Device</td><td style="padding:5px 0;">${escapeHtml(device)}</td></tr>
          <tr><td style="padding:5px 0;color:#94a3b8;">🌐 IP</td><td style="padding:5px 0;font-family:monospace;">${escapeHtml(visitorIp || 'N/A')}</td></tr>
          <tr><td style="padding:5px 0;color:#94a3b8;">🕒 Time</td><td style="padding:5px 0;">${escapeHtml(timestampTr)}</td></tr>
        </table>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <a href="${escapeHtml(upworkUrl)}" style="display:inline-block;background:#14a800;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;margin-right:8px;">Open Upwork Job</a>
        <a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;">Open Loom Video</a>
      </div>
    </div>
  `;

  return sendAlertEmail({ subject, html, text });
}

async function sendBookingEmail({ jobId, jobTitle, selectedDate, selectedTime, visitorTimezone, visitorIp, clientNote, shareUrl }) {
  if (!isEmailConfigured()) {
    return { ok: false, skipped: 'email_not_configured' };
  }
  const cleanJobId = String(jobId || '').trim().replace(/^~?02/, '');
  const upworkUrl = `https://www.upwork.com/jobs/~02${cleanJobId}`;
  const subject = `📞 New Upwork Call Booked! — ${String(jobTitle || cleanJobId).slice(0, 65)}`;
  const text = `New Meeting Booked!\nJob: ${jobTitle}\nDate: ${selectedDate} at ${selectedTime}\nTimezone: ${visitorTimezone || 'N/A'}\nIP: ${visitorIp || 'N/A'}\nNote: ${clientNote || '-'}\nUpwork: ${upworkUrl}\nLoom: ${shareUrl}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#0f172a;color:#f8fafc;border-radius:12px;">
      <h2 style="margin:0 0 12px 0;color:#4ade80;">📞 New Upwork Meeting Booked!</h2>
      <p style="font-size:15px;margin:0 0 12px 0;"><b>${escapeHtml(jobTitle)}</b></p>
      <p style="font-size:14px;color:#cbd5e1;">📅 <b>${escapeHtml(selectedDate)}</b> at <b>${escapeHtml(selectedTime)}</b> (${escapeHtml(visitorTimezone || 'N/A')})</p>
      ${clientNote ? `<p style="font-size:14px;color:#e2e8f0;background:#1e293b;padding:10px;border-radius:8px;">Note: ${escapeHtml(clientNote)}</p>` : ''}
      <p style="margin-top:16px;">
        <a href="${escapeHtml(upworkUrl)}" style="background:#14a800;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;margin-right:8px;">Open Upwork Job</a>
        <a href="${escapeHtml(shareUrl)}" style="background:#6366f1;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">Open Loom Video</a>
      </p>
    </div>
  `;
  return sendAlertEmail({ subject, html, text });
}

module.exports = {
  getEmailConfig,
  isEmailConfigured,
  sendAlertEmail,
  sendVideoWatchEmail,
  sendBookingEmail
};
