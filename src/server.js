const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
require('dotenv').config();

const { db, upsertJobAndSnapshot, getSetting } = require('./db');
const { getFullMarketAnalytics } = require('./analytics');
const { runTrackerCycle, UPWORK_MCP_URL } = require('./upwork-tracker');
const { getFlconsoleToken, setFlconsoleToken, runFlconsoleSyncCycle } = require('./flconsole-tracker');
const { createAuthorizationUrl, exchangeCodeForTokens, getValidAccessToken } = require('./upwork-oauth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));

// Ensure public/videos directory exists and serve statically
const videosDir = path.join(__dirname, '..', 'public', 'videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
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

function getShareHash(jobId) {
  if (String(jobId) === '2122421990107900101') {
    return '7009c82cd76942468c9320b06e1f4ed4';
  }
  return crypto.createHash('md5').update('upwork_loom_' + String(jobId)).digest('hex');
}

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

  const videoMatch = reqPath.match(/^\/videos\/([^/]+)\.mp4$/);
  if (videoMatch) return videoMatch[1];

  return null;
}

app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  const isExternal = Boolean(req.headers['cf-connecting-ip']) ||
    (req.hostname && !['localhost', '127.0.0.1'].includes(req.hostname));

  if (!isExternal) {
    return next();
  }

  if (req.path === '/health') {
    return next();
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (ALLOWED_PUBLIC_ASSETS.has(req.path)) {
      return next();
    }

    const jobId = extractValidExternalJobId(req.path);
    if (jobId && hasValidVideo(jobId)) {
      return next();
    }
  }

  return sendPrivatePortalLocked(req, res);
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/videos/:idOrToken.mp4', (req, res) => {
  const realJobId = resolveVideoJobId(req.params.idOrToken);
  if (!realJobId) return sendPrivatePortalLocked(req, res);
  res.sendFile(path.join(videosDir, `${realJobId}.mp4`));
});
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
    const visitorTz = await detectVisitorTimezone(req);
    res.json({
      ...job,
      job_id: realJobId,
      share_id: getShareHash(realJobId),
      video_url: `/videos/${req.params.jobId}.mp4`,
      visitor_tz: visitorTz
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Generate Loom Video for a Job (SeleniumBase UC + Chrome + FFmpeg)
app.post('/api/generate-loom/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const scriptPath = path.join(__dirname, '..', 'scripts', 'render_video_generator.py');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const upworkUrl = jobId.startsWith('http')
    ? jobId
    : (jobId.startsWith('~') ? `https://www.upwork.com/jobs/${jobId}` : `https://www.upwork.com/jobs/~02${jobId}`);
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
    const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
    const title = job?.title || 'your project';
    const host = req.get('host') || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;
    const cleanTopic = title.replace(/[^a-zA-Z0-9\s,.-]/g, '').trim().toLowerCase();
    const proposalText = `hey there, made you a quick loom video showing exactly how i'd handle this:\n\n${baseUrl}/share/${shareId}\n\ni've done this exact style of project before, i've built ${cleanTopic}\n\nP.S: i've never had a bad review and only 5 stars on upwork so you're in safe hands`;

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
  if (!hasValidVideo(req.params.jobId)) {
    return sendPrivatePortalLocked(req, res);
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'loom.html'));
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

  // Initial flconsole sync on startup if token configured
  setTimeout(() => {
    if (getFlconsoleToken()) {
      runFlconsoleSyncCycle().catch(console.error);
    }
  }, 5000);

  // Background polling timer every 1 minute with flconsole (safe & zero ban risk)
  setInterval(() => {
    if (getFlconsoleToken()) {
      runFlconsoleSyncCycle().catch(console.error);
    }
  }, 60 * 1000);

  // Self keep-alive ping every 4 minutes
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://upwork-mcp-automation.onrender.com';
  setInterval(() => {
    fetch(`${externalUrl}/health`).catch(() => {});
  }, 4 * 60 * 1000);
}

module.exports = { app };
