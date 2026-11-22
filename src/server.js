const dns = require('node:dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
require('dotenv').config();

const { db, upsertJobAndSnapshot, getSetting, setSetting } = require('./db');
const { getFullMarketAnalytics } = require('./analytics');
const { runTrackerCycle, runUpworkMcpRadarCycle, UPWORK_MCP_URL } = require('./upwork-tracker');
const { getFlconsoleToken, setFlconsoleToken, runFlconsoleSyncCycle } = require('./flconsole-tracker');
const { getShareHash, buildRyanCoverLetter, submitAutoProposalForJob, runAutoProposerCycle, setProposalNotificationHandler, setProposalFallbackHandler, ensureVideoGenerated, getDailySubmittedCount, getCurrentTurkeyHour, isNightShiftWindow, getNightShiftSubmittedCount } = require('./auto-proposer');
const { createAuthorizationUrl, exchangeCodeForTokens, getValidAccessToken } = require('./upwork-oauth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));

// Ensure public/videos and public/thumbnails directories exist
const videosDir = path.join(__dirname, '..', 'public', 'videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}
const thumbsDir = path.join(__dirname, '..', 'public', 'thumbnails');
if (!fs.existsSync(thumbsDir)) {
  fs.mkdirSync(thumbsDir, { recursive: true });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const ALLOWED_PUBLIC_ASSETS = new Set([
  '/badge_jss.png',
  '/badge_top_rated.png',
  '/icon_top_rated.png',
  '/profile_pic.jpg',
  '/top_rated_badge.svg',
  '/upwork_logo.svg',
  '/upwork_logo_white.svg',
  '/favicon.ico'
]);

function resolveVideoJobId(idOrToken) {
  if (!idOrToken || !/^[a-zA-Z0-9_~-]+$/.test(idOrToken)) {
    return null;
  }
  if (fs.existsSync(path.join(videosDir, `${idOrToken}.mp4`))) {
    return idOrToken;
  }
  const normalized = idOrToken.toLowerCase();
  const files = fs.readdirSync(videosDir);
  for (const file of files) {
    if (!file.endsWith('.mp4')) continue;
    const base = file.slice(0, -4);
    if (getShareHash(base) === normalized || (base === '2122421990107900101' && normalized === '7009c82cd76942468c9320b06e1f4ed4')) {
      return base;
    }
  }
  const propRow = db.prepare('SELECT job_id FROM auto_proposals WHERE LOWER(share_id) = ? OR job_id = ?').get(normalized, idOrToken);
  if (propRow?.job_id) {
    return propRow.job_id;
  }
  return null;
}

function hasValidVideo(idOrToken) {
  return Boolean(resolveVideoJobId(idOrToken));
}

const ipGeoCache = new Map();

function formatUtcOffset(offsetSeconds) {
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const abs = Math.abs(offsetSeconds);
  const hours = Math.floor(abs / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  return mins > 0 ? `UTC${sign}${hours}:${String(mins).padStart(2, '0')}` : `UTC${sign}${hours}`;
}

async function detectVisitorTimezone(req) {
  try {
    const rawIp = req.headers['cf-connecting-ip'] ||
      (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : '') ||
      req.socket?.remoteAddress ||
      '';
    const cleanIp = String(rawIp).replace(/^::ffff:/, '').trim();
    const isPrivateOrLocal = !cleanIp ||
      cleanIp === '127.0.0.1' ||
      cleanIp === '::1' ||
      cleanIp.startsWith('192.168.') ||
      cleanIp.startsWith('10.') ||
      cleanIp.startsWith('172.');
    const isPublicIp = !isPrivateOrLocal;
    const cacheKey = isPublicIp ? cleanIp : 'LOCAL_PUBLIC_IP';

    if (ipGeoCache.has(cacheKey)) {
      return ipGeoCache.get(cacheKey);
    }

    const url = `http://ip-api.com/json/${isPublicIp ? encodeURIComponent(cleanIp) : ''}?fields=status,country,regionName,city,timezone,offset`;
    const geoRes = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!geoRes.ok) return null;

    const data = await geoRes.json();
    if (data.status === 'success' && data.timezone) {
      const utcOffset = formatUtcOffset(data.offset || 0);
      const locationName = data.regionName || data.city || data.country || '';
      const label = locationName
        ? `Times in ${locationName} · ${data.timezone} (${utcOffset})`
        : `Times in ${data.timezone} (${utcOffset})`;
      const result = {
        timezone: data.timezone,
        utc_offset: utcOffset,
        city: data.city,
        region: data.regionName,
        country: data.country,
        label
      };
      ipGeoCache.set(cacheKey, result);
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

function sendPrivatePortalLocked(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Access denied. Direct invitation link required.' });
  }
  return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow, noarchive" />
  <title>Private Video Portal</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0b0f19; color: #e5e7eb; font-family: system-ui, -apple-system, sans-serif; }
    .card { max-width: 420px; padding: 36px 32px; border-radius: 16px; background: #111827; border: 1px solid #1f2937; text-align: center; box-shadow: 0 20px 45px rgba(0,0,0,0.45); }
    .badge { display: inline-block; padding: 6px 12px; border-radius: 9999px; background: rgba(239,68,68,0.12); color: #f87171; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 16px; }
    h1 { margin: 0 0 10px; font-size: 22px; color: #f9fafb; }
    p { margin: 0; font-size: 14px; line-height: 1.6; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">403 Forbidden</div>
    <h1>Private Video Portal</h1>
    <p>This portal is restricted. A direct proposal video link is required to view content.</p>
  </div>
</body>
</html>`);
}

function extractValidExternalJobId(reqPath) {
  const shareMatch = reqPath.match(/^\/share\/([^/]+)$/);
  if (shareMatch) return shareMatch[1];

  const loomMatch = reqPath.match(/^\/loom\/([^/]+)$/);
  if (loomMatch) return loomMatch[1];

  const apiMatch = reqPath.match(/^\/api\/job\/([^/]+)$/);
  if (apiMatch) return apiMatch[1];

  const bookMatch = reqPath.match(/^\/api\/book-call\/([^/]+)$/);
  if (bookMatch) return bookMatch[1];

  const trackViewMatch = reqPath.match(/^\/api\/track-view\/([^/]+)$/);
  if (trackViewMatch) return trackViewMatch[1];

  const videoMatch = reqPath.match(/^\/videos\/([^/]+)\.mp4$/);
  if (videoMatch) return videoMatch[1];

  const thumbMatch = reqPath.match(/^\/thumbnails\/([^/]+)\.jpg$/);
  if (thumbMatch) return thumbMatch[1];

  return null;
}

app.use((req, res, next) => {
  const isExternal = Boolean(req.headers['cf-connecting-ip']) ||
    (req.hostname && !['localhost', '127.0.0.1'].includes(req.hostname));

  if (!isExternal) {
    return next();
  }

  if (req.path === '/health') {
    return next();
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.path === '/oembed' || ALLOWED_PUBLIC_ASSETS.has(req.path)) {
      return next();
    }

    const jobId = extractValidExternalJobId(req.path);
    if (jobId && hasValidVideo(jobId)) {
      return next();
    }
  }

  if (req.method === 'POST' && (req.path.startsWith('/api/book-call/') || req.path.startsWith('/api/track-view/'))) {
    const jobId = extractValidExternalJobId(req.path);
    if (jobId && hasValidVideo(jobId)) {
      return next();
    }
  }

  return sendPrivatePortalLocked(req, res);
});

app.get('/videos/:idOrToken.mp4', (req, res) => {
  const realJobId = resolveVideoJobId(req.params.idOrToken);
  if (!realJobId) return sendPrivatePortalLocked(req, res);
  const videoFile = path.join(videosDir, `${realJobId}.mp4`);
  if (!fs.existsSync(videoFile)) {
    return res.status(404).end();
  }
  res.sendFile(videoFile);
});

app.get('/thumbnails/:idOrToken.jpg', (req, res) => {
  const realJobId = resolveVideoJobId(req.params.idOrToken);
  if (!realJobId) return sendPrivatePortalLocked(req, res);
  const specificThumb = path.join(thumbsDir, `${realJobId}.jpg`);
  const fallbackThumb = path.join(thumbsDir, '2122421990107900101.jpg');
  const thumbFile = fs.existsSync(specificThumb) ? specificThumb : fallbackThumb;
  if (!fs.existsSync(thumbFile)) {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(thumbFile);
});

app.get('/oembed', (req, res) => {
  const rawUrl = String(req.query.url || '');
  const cleanPath = rawUrl.split('?')[0].split('/').filter(Boolean).pop() || '';
  const matchedId = resolveVideoJobId(cleanPath);
  const realJobId = matchedId || '2122421990107900101';
  const outToken = matchedId ? cleanPath : getShareHash(realJobId);

  const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(realJobId);
  const protocol = req.headers['x-forwarded-proto'] || (req.headers['cf-connecting-ip'] ? 'https' : req.protocol) || 'https';
  const baseUrl = `${protocol}://${req.get('host')}`;
  const title = job?.title ? job.title : 'Quick Video for Your Project';
  const thumbUrl = `${baseUrl}/thumbnails/${outToken}.jpg`;

  res.json({
    version: '1.0',
    type: 'video',
    provider_name: 'Loom',
    provider_url: baseUrl,
    title,
    author_name: 'Sametcan Koksoy',
    author_url: 'https://www.upwork.com/freelancers/~01e3cadc4c04e077b1',
    thumbnail_url: thumbUrl,
    thumbnail_width: 1728,
    thumbnail_height: 1080,
    width: 1728,
    height: 1080,
    html: `<iframe src="${baseUrl}/share/${outToken}" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen width="1728" height="1080"></iframe>`
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/videos', express.static(videosDir));

// Test endpoint to benchmark and verify headless SeleniumBase + Chrome + FFmpeg video generation on Render
app.get('/api/test-render-video', (req, res) => {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.join(__dirname, '..', 'scripts', 'render_video_generator.py');
  const startMem = process.memoryUsage();
  console.log('[Render-Test] Starting test video generation on Render...');

  execFile(pythonCmd, [scriptPath], { timeout: 120000 }, (err, stdout, stderr) => {
    const endMem = process.memoryUsage();
    if (err) {
      console.error('[Render-Test] Error generating video:', err, stderr);
      return res.status(500).json({
        success: false,
        error: err.message,
        stderr: stderr.slice(-1000),
        stdout: stdout.slice(-1000),
        memoryMB: {
          startRSS: Math.round(startMem.rss / 1024 / 1024),
          endRSS: Math.round(endMem.rss / 1024 / 1024)
        }
      });
    }

    res.json({
      success: true,
      stdout: stdout.slice(-1000),
      memoryMB: {
        startRSS: Math.round(startMem.rss / 1024 / 1024),
        endRSS: Math.round(endMem.rss / 1024 / 1024)
      },
      videoUrl: '/videos/test_render_engine.mp4'
    });
  });
});

// API: Full Market Intelligence Analytics
app.get('/api/analytics', async (req, res) => {
  try {
    const keyword = req.query.keyword || 'ALL';
    const data = getFullMarketAnalytics(keyword);
    const keywords = db.prepare('SELECT * FROM tracked_keywords ORDER BY active DESC, keyword ASC').all();
    const recentRuns = db.prepare('SELECT * FROM bot_runs ORDER BY id DESC LIMIT 8').all();
    const validToken = await getValidAccessToken();
    const tokenMeta = getSetting('upwork_tokens');
    res.json({
      ...data,
      trackedKeywords: keywords,
      recentRuns,
      upworkConfig: {
        hasAccessToken: Boolean(validToken),
        connectedAt: tokenMeta?.connected_at || null,
        mcpEndpoint: UPWORK_MCP_URL,
        accountMode: validToken ? 'Connected (Live Upwork MCP)' : 'Simulation / Sandbox Dataset'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OAuth 2.1 Dynamic Client Registration + PKCE Login Flow for Official Upwork MCP
app.get('/auth/upwork/login', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = `${protocol}://${req.get('host')}`;
    const authUrl = await createAuthorizationUrl(baseUrl);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`OAuth initialization error: ${err.message}`);
  }
});

app.get('/auth/upwork/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      return res.status(400).send(`Upwork Auth Error: ${error} - ${error_description || ''}`);
    }
    await exchangeCodeForTokens(code, state);
    // Trigger immediate live sync
    runTrackerCycle({ simulateStep: false }).catch(console.error);
    res.redirect('/?connected=1');
  } catch (err) {
    res.status(500).send(`OAuth Callback Error: ${err.message}`);
  }
});

// API: Clear Mock Data (Start Fresh for Live Only)
app.post('/api/clear-mock', (req, res) => {
  try {
    db.exec(`DELETE FROM job_snapshots WHERE job_id LIKE '~01upw%' OR job_id LIKE '~01sniper%' OR job_id LIKE '~01test%';`);
    db.exec(`DELETE FROM jobs WHERE job_id LIKE '~01upw%' OR job_id LIKE '~01sniper%' OR job_id LIKE '~01test%';`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Single Job Lifecycle History (Snapshots)
app.get('/api/jobs/:jobId/snapshots', (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(req.params.jobId);
    const snapshots = db
      .prepare('SELECT * FROM job_snapshots WHERE job_id = ? ORDER BY checked_at ASC')
      .all(req.params.jobId);
    res.json({ job, snapshots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Trigger Poll / Snapshot Update
app.post('/api/poll', async (req, res) => {
  try {
    if (getFlconsoleToken()) {
      const result = await runFlconsoleSyncCycle();
      return res.json({ ok: true, engine: 'flconsole', result });
    }
    const result = await runTrackerCycle({ simulateStep: true });
    res.json({ ok: true, engine: 'simulation', result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: flconsole Status & Configuration
app.get('/api/flconsole/status', (req, res) => {
  const token = getFlconsoleToken();
  const lastRun = db.prepare("SELECT * FROM bot_runs WHERE run_type = 'flconsole_mcp_sync' ORDER BY started_at DESC LIMIT 1").get();
  res.json({
    configured: !!token,
    lastRun: lastRun || null
  });
});

app.post('/api/flconsole/token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    setFlconsoleToken(token);
    const syncRes = await runFlconsoleSyncCycle();
    res.json({ ok: true, syncResult: syncRes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Add / Toggle Tracked Keyword
app.post('/api/keywords', (req, res) => {
  try {
    const { keyword, category } = req.body;
    if (!keyword) return res.status(400).json({ error: 'Keyword required' });
    db.prepare('INSERT OR IGNORE INTO tracked_keywords (keyword, category, active) VALUES (?, ?, 1)').run(
      keyword.trim(),
      category || 'Custom'
    );
    res.json({ ok: true, keywords: db.prepare('SELECT * FROM tracked_keywords').all() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Ingest Live Job from Upwork MCP / Extension / Test Profile
app.post('/api/ingest', (req, res) => {
  try {
    const payload = req.body;
    if (!payload.job_id || !payload.title) {
      return res.status(400).json({ error: 'job_id and title are required' });
    }
    const isNew = upsertJobAndSnapshot(payload);
    res.json({ ok: true, isNew, job_id: payload.job_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Bulk Ingest from Local / Client with Token Sync
app.post('/api/bulk-ingest', (req, res) => {
  try {
    const { jobs, tokens } = req.body;
    let added = 0;
    if (Array.isArray(jobs)) {
      for (const j of jobs) {
        if (j.job_id && j.title) {
          upsertJobAndSnapshot(j);
          added++;
        }
      }
    }
    if (tokens && tokens.access_token) {
      const { setSetting } = require('./db');
      setSetting('upwork_tokens', tokens);
      if (tokens.org_uid) setSetting('upwork_org_uid', tokens.org_uid);
    }
    res.json({ ok: true, ingested: added, totalInDb: db.prepare('SELECT COUNT(*) as c FROM jobs').get().c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Single Job Details
app.get('/api/job/:jobId', async (req, res) => {
  try {
    const realJobId = resolveVideoJobId(req.params.jobId);
    if (!realJobId) {
      return sendPrivatePortalLocked(req, res);
    }
    let job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(realJobId);
    if (!job && realJobId === '2119487430141316904') {
      job = {
        job_id: '2119487430141316904',
        title: 'AI engineering consultant to audit how I build software with AI agents, top to bottom',
        description: 'Audit architecture, data security, error handling, and deployment pipeline for an operating web/desktop app built with AI agents.',
        client_country: 'United States',
        client_hire_rate: 100,
        budget: 0,
        hourly_min: 45,
        hourly_max: 90
      };
    }
    if (!job) {
      job = {
        job_id: realJobId,
        title: 'Software & Automation Requirements',
        client_country: 'United States',
        client_hire_rate: 100
      };
    }
    const videoReady = fs.existsSync(path.join(videosDir, `${realJobId}.mp4`));
    if (!videoReady) {
      ensureVideoGenerated(realJobId, false).catch(() => {});
    }
    const visitorTz = await detectVisitorTimezone(req);
    res.json({
      ...job,
      job_id: realJobId,
      share_id: getShareHash(realJobId),
      video_url: `/videos/${req.params.jobId}.mp4`,
      video_ready: videoReady,
      visitor_tz: visitorTz
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Record Client Call Booking (ToS-compliant, zero email/form required)
app.post('/api/book-call/:jobId', (req, res) => {
  try {
    const realJobId = resolveVideoJobId(req.params.jobId);
    if (!realJobId) {
      return sendPrivatePortalLocked(req, res);
    }

    const { selected_date, selected_time, visitor_timezone, client_note } = req.body || {};
    if (!selected_date || !selected_time) {
      return res.status(400).json({ ok: false, error: 'selected_date and selected_time are required' });
    }

    const job = db.prepare('SELECT title FROM jobs WHERE job_id = ?').get(realJobId);
    const jobTitle = job?.title || 'Upwork Project';
    const shareId = getShareHash(realJobId);
    const visitorIp = req.headers['cf-connecting-ip'] ||
      (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : '') ||
      req.socket?.remoteAddress ||
      '';

    const info = db.prepare(`
      INSERT INTO call_bookings (job_id, share_id, job_title, selected_date, selected_time, visitor_timezone, visitor_ip, client_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      realJobId,
      shareId,
      jobTitle,
      String(selected_date).slice(0, 80),
      String(selected_time).slice(0, 40),
      String(visitor_timezone || '').slice(0, 120),
      String(visitorIp).slice(0, 80),
      String(client_note || '').slice(0, 500)
    );

    console.log(`[CALL BOOKED] #${info.lastInsertRowid} | Job: ${realJobId} (${jobTitle}) | ${selected_date} at ${selected_time} | ${visitor_timezone || 'N/A'} | IP: ${visitorIp}`);
    notifyVideoActivity({
      title: '📞 New Meeting Booked on Upwork!',
      subtitle: `${jobTitle}`,
      bodyText: `${selected_date} at ${selected_time} | ${visitor_timezone || visitorIp}`
    });
    res.json({ ok: true, booking_id: Number(info.lastInsertRowid), job_id: realJobId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function showWindowsBalloon(title, bodyText) {
  if (process.platform !== 'win32') return;
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.BalloonTipIcon = 'Info'
    $n.BalloonTipTitle = $env:LOOM_NOTIF_TITLE
    $n.BalloonTipText = $env:LOOM_NOTIF_BODY
    $n.Visible = $true
    $n.ShowBalloonTip(7000)
    Start-Sleep -Milliseconds 1500
    $n.Dispose()
  `;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    {
      windowsHide: true,
      timeout: 8000,
      env: {
        ...process.env,
        LOOM_NOTIF_TITLE: String(title || 'Upwork Video Bildirimi').slice(0, 63),
        LOOM_NOTIF_BODY: String(bodyText || '').slice(0, 250)
      }
    },
    () => {}
  );
}

function notifyDesktopAndTelegram({ logTag = 'NOTIFY', title, subtitle, bodyText }) {
  console.log(`[${logTag}] ${title} | ${subtitle} | ${bodyText}`);
  showWindowsBalloon(title, `${subtitle}\n${bodyText}`);

  const tgToken = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  const tgChatId = process.env.TELEGRAM_CHAT_ID || getSetting('telegram_chat_id');
  if (tgToken && tgChatId) {
    const msg = `${title}\n${subtitle}\n${bodyText}`;
    fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text: msg })
    }).catch(() => {});
  }
}

function notifyVideoActivity({ title, subtitle, bodyText }) {
  notifyDesktopAndTelegram({ logTag: 'VIDEO WATCHED', title, subtitle, bodyText });
}

setProposalNotificationHandler(({ job, shareUrl, chargedAmount, connectsCost }) => {
  const rateLabel = (job?.job_type || '').toLowerCase() === 'hourly' ? `$${chargedAmount}/hr` : `$${chargedAmount}`;
  notifyDesktopAndTelegram({
    logTag: 'AUTO-PROPOSAL SENT',
    title: '🔥 New Proposal Submitted!',
    subtitle: job?.title || `Upwork Job (${job?.job_id || ''})`,
    bodyText: `${rateLabel} | ${connectsCost} Connects | ${shareUrl}`
  });
});

function buildUpworkApplyUrl(jobId) {
  const cleanId = String(jobId || '').trim().replace(/^~?02/, '');
  return `https://www.upwork.com/ab/proposals/job/~02${cleanId}/apply/`;
}

function escapeTgHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramMessage(text, options = {}) {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  const tgChatId = options.chatId || process.env.TELEGRAM_CHAT_ID || getSetting('telegram_chat_id');
  if (!tgToken || !tgChatId) return null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tgChatId,
        text,
        parse_mode: options.parseMode || 'HTML',
        disable_web_page_preview: options.disablePreview ?? true,
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
      })
    });
    return await resp.json();
  } catch (err) {
    console.error('[Telegram] sendMessage failed:', err.message);
    return null;
  }
}

setProposalFallbackHandler(async ({ job, coverLetter, shareUrl, chargedAmount, connectsCost, error }) => {
  const cleanId = String(job?.job_id || '').trim().replace(/^~?02/, '');
  const rateLabel = (job?.job_type || '').toLowerCase() === 'hourly' ? `$${chargedAmount}/hr` : `$${chargedAmount}`;
  const applyUrl = buildUpworkApplyUrl(job?.job_id);
  const errSummary = String(typeof error === 'object' ? JSON.stringify(error) : (error || 'UNEXPECTED_ERROR')).slice(0, 180);

  console.log(`[AUTO-PROPOSAL FALLBACK] Job ${job?.job_id} | Dispatching 1-Click Apply + MCP Approve button to Telegram`);
  showWindowsBalloon('⚠️ Upwork Proposal Ready (1-Click)', `${job?.title || job?.job_id}\n1-Click application & MCP retry sent to Telegram.`);

  const text = `⚡ <b>Proposal Ready — 1-Click Apply</b>\n\n` +
    `📌 <b>Job:</b> ${escapeTgHtml(job?.title || job?.job_id)}\n` +
    `💰 <b>Rate:</b> ${rateLabel}${connectsCost ? ` | <b>Connects:</b> ${connectsCost}` : ''}\n` +
    `⚠️ <b>MCP Status:</b> <code>${escapeTgHtml(errSummary)}</code>\n\n` +
    `📋 <b>Cover Letter (Tap to copy):</b>\n` +
    `<code>${escapeTgHtml(coverLetter || '')}</code>\n\n` +
    `👇 <i>Tap 1-Click Apply to submit safely in your browser, or tap Approve &amp; Retry MCP once cooldown clears.</i>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🚀 1-Click Apply on Upwork', url: applyUrl }
      ],
      [
        { text: '✅ Approve & Retry via MCP', callback_data: `mcp_retry:${cleanId}` },
        { text: '🎥 Watch Loom Video', url: shareUrl }
      ]
    ]
  };

  await sendTelegramMessage(text, { replyMarkup: inlineKeyboard });
});

function startTelegramInteractiveBot() {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  const allowedChatId = String(process.env.TELEGRAM_CHAT_ID || getSetting('telegram_chat_id') || '');
  if (!tgToken || !allowedChatId) return;

  let offset = Number(getSetting('telegram_update_offset') || 0);
  const activeRetries = new Set();

  async function answerCallback(callbackQueryId, text, showAlert = false) {
    try {
      await fetch(`https://api.telegram.org/bot${tgToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text: String(text || '').slice(0, 190), show_alert: showAlert })
      });
    } catch {}
  }

  async function handleStatusCommand(chatId) {
    const mcpRadarOn = getSetting('upwork_mcp_radar_enabled') === true;
    const autoPropOn = getSetting('auto_proposer_enabled') !== false;
    const dailyCount = getDailySubmittedCount();
    const maxDaily = Number(getSetting('daily_proposal_limit') ?? 5);
    const lastFlc = db.prepare(`SELECT started_at, status, details FROM bot_runs WHERE run_type = 'flconsole_mcp_sync' ORDER BY id DESC LIMIT 1`).get();

    let cooldownText = 'Unknown (no token)';
    let connectsText = 'N/A';
    try {
      const token = await getValidAccessToken();
      if (token) {
        const { callUpworkMcpTool, getTalentOrgUid } = require('./upwork-tracker');
        const orgUid = await getTalentOrgUid(token);
        const dash = await callUpworkMcpTool('upwork__get_freelancer_dashboard', { action: 'check', org_uid: orgUid }, token).catch(() => null);
        connectsText = String(dash?.data?.connects?.balance?.connectsBalance ?? 'N/A');
        const sample = db.prepare(`SELECT job_id FROM jobs ORDER BY posted_at DESC LIMIT 1`).get();
        if (sample) {
          try {
            await callUpworkMcpTool('upwork__find_jobs', {
              action: 'get',
              org_uid: orgUid,
              params: { job_id: String(sample.job_id).replace(/^~?02/, '') }
            }, token);
            cooldownText = '✅ CLEAR (Upwork MCP Ready)';
          } catch (e) {
            cooldownText = `⏳ ACTIVE (${String(e.message || '').slice(0, 90)})`;
          }
        }
      }
    } catch (e) {
      cooldownText = `Error: ${e.message}`;
    }

    const msg = `🤖 <b>Upwork Automation Live Status</b>\n\n` +
      `• <b>Upwork MCP Radar (40s):</b> ${mcpRadarOn ? '⚠️ ON' : '🛡️ PAUSED (Safe Mode)'}\n` +
      `• <b>flconsole 24/7 Radar:</b> ✅ Active (${escapeTgHtml(lastFlc?.details || 'waiting')})\n` +
      `• <b>Auto-Proposer:</b> ${autoPropOn ? '✅ Enabled' : '⏸️ Paused'} (${dailyCount}/${maxDaily} today)\n` +
      `• <b>Connects Balance:</b> ${connectsText}\n` +
      `• <b>Upwork Cooldown Check:</b> ${escapeTgHtml(cooldownText)}\n\n` +
      `<i>Commands: /status · /pause_auto · /resume_auto</i>`;
    await sendTelegramMessage(msg, { chatId });
  }

  async function pollOnce() {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${tgToken}/getUpdates?timeout=20&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'callback_query']))}`, {
        signal: AbortSignal.timeout(28000)
      });
      const data = await resp.json();
      if (data?.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = Math.max(offset, Number(upd.update_id) + 1);
          setSetting('telegram_update_offset', offset);

          if (upd.callback_query) {
            const cb = upd.callback_query;
            const chatId = String(cb.message?.chat?.id || '');
            if (chatId !== allowedChatId) continue;
            const payload = String(cb.data || '');

            if (payload.startsWith('mcp_retry:')) {
              const targetId = payload.slice('mcp_retry:'.length).replace(/^~?02/, '');
              if (activeRetries.has(targetId)) {
                await answerCallback(cb.id, 'Already submitting this job...');
                continue;
              }
              const job = db.prepare(`SELECT * FROM jobs WHERE job_id = ? OR job_id = ?`).get(targetId, `02${targetId}`);
              if (!job) {
                await answerCallback(cb.id, 'Job not found in local DB.', true);
                continue;
              }
              activeRetries.add(targetId);
              await answerCallback(cb.id, '⏳ Submitting via Upwork MCP...');
              submitAutoProposalForJob(job, { force: true, skipFallbackNotify: true })
                .then(async (res) => {
                  if (res?.ok) {
                    await sendTelegramMessage(
                      `✅ <b>Approved &amp; Submitted via Upwork MCP!</b>\n\n📌 ${escapeTgHtml(job.title)}\n💰 $${res.charged_amount} | ${res.connects_cost} Connects\n🎥 ${escapeTgHtml(res.share_url)}`,
                      { chatId }
                    );
                  } else {
                    await sendTelegramMessage(
                      `⚠️ <b>MCP Retry Still Blocked</b>\n\n📌 ${escapeTgHtml(job.title)}\n❌ <code>${escapeTgHtml(String(res?.error || res?.status || 'Unknown error').slice(0, 200))}</code>\n\n👉 Use the 1-Click Apply button above to submit directly in your browser.`,
                      {
                        chatId,
                        replyMarkup: {
                          inline_keyboard: [[{ text: '🚀 1-Click Apply on Upwork', url: buildUpworkApplyUrl(job.job_id) }]]
                        }
                      }
                    );
                  }
                })
                .catch(async (err) => {
                  await sendTelegramMessage(`❌ MCP Retry error: <code>${escapeTgHtml(err.message)}</code>`, { chatId });
                })
                .finally(() => activeRetries.delete(targetId));
            }
          } else if (upd.message?.text) {
            const chatId = String(upd.message.chat?.id || '');
            if (chatId !== allowedChatId) continue;
            const cmd = upd.message.text.trim().split(/\s+/)[0].toLowerCase();
            if (cmd === '/status') {
              await handleStatusCommand(chatId);
            } else if (cmd === '/pause_auto') {
              setSetting('auto_proposer_enabled', false);
              await sendTelegramMessage('⏸️ <b>Auto-Proposer paused.</b>', { chatId });
            } else if (cmd === '/resume_auto') {
              setSetting('auto_proposer_enabled', true);
              await sendTelegramMessage('▶️ <b>Auto-Proposer resumed.</b>', { chatId });
            }
          }
        }
      }
    } catch (err) {
      if (!/abort|timeout/i.test(String(err?.message || ''))) {
        console.warn('[TelegramBot] Poll error:', err.message);
      }
    }
    setTimeout(pollOnce, 1500);
  }

  console.log('[TelegramBot] Interactive callback & command polling started.');
  setTimeout(pollOnce, 2500);
}

// API: Real-Time Video Watch Tracking & Notifications
app.post('/api/track-view/:jobId', async (req, res) => {
  try {
    const userAgent = String(req.headers['user-agent'] || '');
    if (/(TelegramBot|Slackbot|Discordbot|Twitterbot|facebookexternalhit|LinkedInBot|WhatsApp)/i.test(userAgent)) {
      return res.json({ ok: true, ignored: 'bot' });
    }

    const realJobId = resolveVideoJobId(req.params.jobId);
    if (!realJobId) {
      return sendPrivatePortalLocked(req, res);
    }

    const allowedEvents = new Set(['page_open', 'video_play', 'video_50pct', 'video_completed']);
    const eventType = allowedEvents.has(req.body?.event_type) ? req.body.event_type : 'page_open';
    const watchSeconds = Math.max(0, Math.round(Number(req.body?.watch_seconds || 0)));

    const job = db.prepare('SELECT title FROM jobs WHERE job_id = ?').get(realJobId);
    const jobTitle = job?.title || `Upwork Job (${realJobId})`;
    const shareId = getShareHash(realJobId);
    const visitorIp = req.headers['cf-connecting-ip'] ||
      (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : '') ||
      req.socket?.remoteAddress ||
      '';
    const tzInfo = await detectVisitorTimezone(req);
    const visitorLocation = [tzInfo?.city, tzInfo?.region, tzInfo?.country].filter(Boolean).join(', ') || 'Unknown Location';
    const visitorTimezone = tzInfo?.label || '';

    const info = db.prepare(`
      INSERT INTO video_views (job_id, share_id, job_title, event_type, watch_seconds, visitor_location, visitor_timezone, visitor_ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      realJobId,
      shareId,
      jobTitle,
      eventType,
      watchSeconds,
      visitorLocation,
      visitorTimezone,
      String(visitorIp).slice(0, 80),
      userAgent.slice(0, 300)
    );

    const eventLabels = {
      page_open: 'Opened Proposal Page',
      video_play: 'Started Watching Video',
      video_50pct: 'Watched 50% of Video',
      video_completed: 'Finished Video (100%)'
    };

    notifyVideoActivity({
      title: `Client ${eventLabels[eventType]}`,
      subtitle: jobTitle,
      bodyText: `${visitorLocation}${tzInfo?.utc_offset ? ` (${tzInfo.utc_offset})` : ''} | Duration: ${watchSeconds}s`
    });

    res.json({ ok: true, view_id: Number(info.lastInsertRowid), event_type: eventType });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: List Video Watch Events (local dashboard only)
app.get('/api/video-views', (req, res) => {
  try {
    const views = db.prepare('SELECT * FROM video_views ORDER BY id DESC LIMIT 100').all();
    res.json({ ok: true, views });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: List Recent Client Bookings (local dashboard only)
app.get('/api/bookings', (req, res) => {
  try {
    const bookings = db.prepare('SELECT * FROM call_bookings ORDER BY id DESC LIMIT 100').all();
    res.json({ ok: true, bookings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Auto-Proposer History, Toggle & Manual Trigger (local dashboard only)
app.get('/api/auto-proposals', (req, res) => {
  try {
    const proposals = db.prepare('SELECT * FROM auto_proposals ORDER BY id DESC LIMIT 100').all();
    const countSubmittedToday = getDailySubmittedCount();
    const dailyLimit = Number(getSetting('daily_proposal_limit') ?? 5);
    const trHour = getCurrentTurkeyHour();
    res.json({
      ok: true,
      enabled: getSetting('auto_proposer_enabled') !== false,
      daily_limit: dailyLimit,
      submitted_today: countSubmittedToday,
      limit_reached: countSubmittedToday >= dailyLimit,
      turkey_hour: trHour,
      proposer_mode: '24_7_exact_match_only',
      proposals
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auto-proposals/limit', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.body?.limit) || 10));
    setSetting('daily_proposal_limit', limit);
    res.json({ ok: true, daily_limit: limit, submitted_today: getDailySubmittedCount() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auto-proposals/toggle', (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    setSetting('auto_proposer_enabled', enabled);
    res.json({ ok: true, enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auto-proposals/apply/:jobId', async (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found in local database' });
    }
    const result = await submitAutoProposalForJob(job, {
      dryRun: Boolean(req.body?.dryRun),
      force: Boolean(req.body?.force)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Generate Loom Video for a Job (SeleniumBase UC + Chrome + FFmpeg)
app.post('/api/generate-loom/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const scriptPath = path.join(__dirname, '..', 'scripts', 'render_video_generator.py');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const upworkUrl = jobId.startsWith('http')
    ? jobId
    : (jobId.startsWith('~')
      ? `https://www.upwork.com/jobs/${jobId}`
      : (jobId.startsWith('02') && jobId.length >= 20
        ? `https://www.upwork.com/jobs/~${jobId}`
        : `https://www.upwork.com/jobs/~02${jobId}`));
  const outPath = path.join(videosDir, `${jobId}.mp4`);

  console.log(`[Video-Gen] Generating video for ${jobId} -> ${upworkUrl}...`);

  execFile(pythonCmd, [scriptPath, upworkUrl, outPath], { maxBuffer: 1024 * 1024 * 20, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[Video-Gen] Error:', stderr || err.message);
      return res.status(500).json({ ok: false, error: stderr || err.message });
    }
    const shareId = getShareHash(jobId);
    const videoFile = `/videos/${shareId}.mp4`;
    const loomPage = `/share/${shareId}`;
    const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) || { job_id: jobId, title: 'your project', description: '' };
    const host = req.get('host') || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;
    const proposalText = buildRyanCoverLetter(job, `${baseUrl}/share/${shareId}`);

    res.json({
      ok: true,
      job_id: jobId,
      share_id: shareId,
      video_url: videoFile,
      loom_url: loomPage,
      proposal_text: proposalText
    });
  });
});

// Route: Loom View Player Page (/share/<32-char-hex> and legacy /loom/:jobId)
app.get(['/share/:jobId', '/loom/:jobId'], (req, res) => {
  const realJobId = resolveVideoJobId(req.params.jobId);
  if (!realJobId) {
    return sendPrivatePortalLocked(req, res);
  }

  const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(realJobId);
  const protocol = req.headers['x-forwarded-proto'] || (req.headers['cf-connecting-ip'] ? 'https' : req.protocol) || 'https';
  const baseUrl = `${protocol}://${req.get('host')}`;
  const rawTitle = job?.title ? job.title : 'Quick Video for Your Project';
  const rawDesc = '35 sec video recorded by Sametcan Koksoy (Top Rated · 100% Job Success) · Click to watch';
  const thumbUrl = `${baseUrl}/thumbnails/${req.params.jobId}.jpg`;
  const videoUrl = `${baseUrl}/videos/${req.params.jobId}.mp4`;
  const pageUrl = `${baseUrl}${req.originalUrl}`;
  const oembedUrl = `${baseUrl}/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;

  const safeTitle = escapeHtml(rawTitle);
  const safeDesc = escapeHtml(rawDesc);
  const safeThumbUrl = escapeHtml(thumbUrl);
  const safeVideoUrl = escapeHtml(videoUrl);
  const safePageUrl = escapeHtml(pageUrl);
  const safeOembedUrl = escapeHtml(oembedUrl);

  const metaTags = `<title id="pageTitle">${safeTitle} | Loom</title>
  <meta name="description" content="${safeDesc}" />
  <meta property="og:site_name" content="Loom" />
  <meta property="og:type" content="video.other" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:url" content="${safePageUrl}" />
  <meta property="og:image" content="${safeThumbUrl}" />
  <meta property="og:image:secure_url" content="${safeThumbUrl}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1728" />
  <meta property="og:image:height" content="1080" />
  <meta property="og:video" content="${safeVideoUrl}" />
  <meta property="og:video:secure_url" content="${safeVideoUrl}" />
  <meta property="og:video:type" content="video/mp4" />
  <meta property="og:video:width" content="1728" />
  <meta property="og:video:height" content="1080" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeThumbUrl}" />
  <meta name="twitter:player" content="${safePageUrl}" />
  <meta name="twitter:player:width" content="1728" />
  <meta name="twitter:player:height" content="1080" />
  <meta name="twitter:player:stream" content="${safeVideoUrl}" />
  <meta name="twitter:player:stream:content_type" content="video/mp4" />
  <link rel="alternate" type="application/json+oembed" href="${safeOembedUrl}" title="${safeTitle}" />`;

  let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loom.html'), 'utf8');
  html = html.replace('<title id="pageTitle">Video Message | Upwork</title>', metaTags);
  html = html.replace('<video id="loomVideo" class="w-full h-full object-contain cursor-pointer" playsinline preload="auto">', `<video id="loomVideo" poster="${safeThumbUrl}" class="w-full h-full object-contain cursor-pointer" playsinline preload="auto">`);
  html = html.replace('<source id="videoSrc" src="" type="video/mp4">', `<source id="videoSrc" src="${safeVideoUrl}" type="video/mp4">`);

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

const PORT = process.env.PORT || 3050;

// Healthcheck endpoint for UptimeRobot / Cron-job.org / Render keep-alive
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Upwork Market Intelligence Server running on http://localhost:${PORT}`);
  });

  // Safe Upwork MCP Radar loop: DISABLED by default to protect account from Upwork search/browse cooldowns.
  // Primary 24/7 zero-risk job discovery runs via flconsole below.
  // If explicitly enabled via setting upwork_mcp_radar_enabled=true, enforces a safe >= 3 minute interval.
  function scheduleNextUpworkMcpRadar(delayMs = 5000) {
    setTimeout(async () => {
      let nextDelay = 180 * 1000;
      try {
        if (getSetting('upwork_mcp_radar_enabled') === true) {
          const token = await getValidAccessToken();
          if (token) {
            const res = await runUpworkMcpRadarCycle();
            if (res?.newJobsFound > 0) {
              runAutoProposerCycle(3).catch(err => console.error('[Auto-Proposer] Trigger error:', err));
            }
          }
        }
      } catch (err) {
        console.error('[upwork-mcp-radar] Cycle error:', err);
      }
      scheduleNextUpworkMcpRadar(nextDelay);
    }, delayMs);
  }

  scheduleNextUpworkMcpRadar(5000);

  // Start interactive Telegram bot (handles Approve & Retry MCP button + /status, /pause_auto, /resume_auto)
  startTelegramInteractiveBot();

  // Primary 24/7 zero-risk flconsole sync loop (~61s, zero load on personal Upwork OAuth account)
  function scheduleNextFlconsoleSync(delayMs = 2000) {
    setTimeout(async () => {
      let nextDelay = 61 * 1000;
      try {
        if (getFlconsoleToken()) {
          const res = await runFlconsoleSyncCycle();
          if (res?.status === 'throttled') {
            nextDelay = Math.max(5, Number(res.retry_after_seconds || 30) + 1) * 1000;
          }
        }
      } catch (err) {
        console.error('[flconsole-sync] Cycle error:', err);
      }
      scheduleNextFlconsoleSync(nextDelay);
    }, delayMs);
  }

  scheduleNextFlconsoleSync(2000);

  // Realtime proposal watcher every 40 seconds (strictly respects Upwork MCP rate limit)
  setInterval(() => {
    runAutoProposerCycle(2).catch(err => console.error('[Auto-Proposer] Loop error:', err));
  }, 40 * 1000);

  // Self keep-alive ping every 4 minutes
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://upwork-mcp-automation.onrender.com';
  setInterval(() => {
    fetch(`${externalUrl}/health`).catch(() => {});
  }, 4 * 60 * 1000);
}

module.exports = { app };
