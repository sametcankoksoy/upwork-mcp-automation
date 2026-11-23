const dns = require('node:dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Readable } = require('node:stream');
const { execFile } = require('node:child_process');
require('dotenv').config();

const { db, upsertJobAndSnapshot, getSetting, setSetting } = require('./db');
const { getFullMarketAnalytics } = require('./analytics');
const { runTrackerCycle, runUpworkMcpRadarCycle, UPWORK_MCP_URL } = require('./upwork-tracker');
const { getFlconsoleToken, setFlconsoleToken, runFlconsoleSyncCycle } = require('./flconsole-tracker');
const { getShareHash, buildRyanCoverLetter, submitAutoProposalForJob, runAutoProposerCycle, setProposalNotificationHandler, setProposalFallbackHandler, ensureVideoGenerated, getDailySubmittedCount, getCurrentTurkeyHour, isNightShiftWindow, getNightShiftSubmittedCount } = require('./auto-proposer');
const { createAuthorizationUrl, exchangeCodeForTokens, getValidAccessToken } = require('./upwork-oauth');
const { sendVideoWatchEmail, sendBookingEmail, sendAlertEmail, isEmailConfigured } = require('./email-notifier');
const { resolveCloudVideoMeta, uploadJobVideoToCloud } = require('./cloud-video-sync');

const IS_RENDER_CLOUD = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || process.env.PORTAL_ONLY === 'true');

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

// Temporary on-disk video and thumbnail cache for fast streaming & mobile range playback on cloud
const tmpVideoDir = path.join(os.tmpdir(), 'loom_video_cache');
if (!fs.existsSync(tmpVideoDir)) {
  try { fs.mkdirSync(tmpVideoDir, { recursive: true }); } catch {}
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

async function resolveVideoInfoAsync(idOrToken) {
  const localJobId = resolveVideoJobId(idOrToken);
  if (localJobId) {
    const localVideoPath = path.join(videosDir, `${localJobId}.mp4`);
    const specificThumb = path.join(thumbsDir, `${localJobId}.jpg`);
    const hasLocalVideo = fs.existsSync(localVideoPath);
    const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(localJobId);
    if (hasLocalVideo) {
      return {
        jobId: localJobId,
        shareId: getShareHash(localJobId),
        title: job?.title || '',
        clientCountry: job?.client_country || '',
        job,
        hasLocalVideo: true,
        localVideoPath,
        localThumbPath: fs.existsSync(specificThumb) ? specificThumb : null,
        cloudMeta: null
      };
    }
    // Local DB knows the job, check cloud CDN for rendered video (e.g. Render portal)
    const cloudMeta = await resolveCloudVideoMeta(idOrToken) || await resolveCloudVideoMeta(getShareHash(localJobId));
    return {
      jobId: localJobId,
      shareId: cloudMeta?.share_id || getShareHash(localJobId),
      title: job?.title || cloudMeta?.title || '',
      clientCountry: job?.client_country || cloudMeta?.client_country || '',
      job,
      hasLocalVideo: false,
      localVideoPath: null,
      localThumbPath: fs.existsSync(specificThumb) ? specificThumb : null,
      cloudMeta
    };
  }

  const cloudMeta = await resolveCloudVideoMeta(idOrToken);
  if (!cloudMeta) return null;
  const dbJob = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(cloudMeta.job_id);
  return {
    jobId: cloudMeta.job_id,
    shareId: cloudMeta.share_id,
    title: dbJob?.title || cloudMeta.title || 'Quick Video for Your Project',
    clientCountry: dbJob?.client_country || cloudMeta.client_country || '',
    job: dbJob || null,
    hasLocalVideo: false,
    localVideoPath: null,
    localThumbPath: null,
    cloudMeta
  };
}

const ipGeoCache = new Map();

function formatUtcOffset(offsetSeconds) {
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const abs = Math.abs(offsetSeconds);
  const hours = Math.floor(abs / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  return mins > 0 ? `UTC${sign}${hours}:${String(mins).padStart(2, '0')}` : `UTC${sign}${hours}`;
}

const regionDisplayNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();

function cfCountryFallback(req) {
  const code = String(req.headers['cf-ipcountry'] || '').trim().toUpperCase();
  if (!code || code === 'XX' || code === 'T1') return null;
  let countryName = code;
  try {
    if (regionDisplayNames) countryName = regionDisplayNames.of(code) || code;
  } catch {}
  return {
    timezone: '',
    utc_offset: '',
    city: '',
    region: '',
    country: countryName,
    label: countryName
  };
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
    if (!geoRes.ok) return cfCountryFallback(req);

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
    return cfCountryFallback(req);
  } catch {
    return cfCountryFallback(req);
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

app.use(async (req, res, next) => {
  const isExternal = Boolean(req.headers['cf-connecting-ip']) ||
    IS_RENDER_CLOUD ||
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
    if (jobId) {
      const info = await resolveVideoInfoAsync(jobId);
      if (info) {
        req.resolvedVideoInfo = info;
        return next();
      }
    }
  }

  if (req.method === 'POST' && (req.path.startsWith('/api/book-call/') || req.path.startsWith('/api/track-view/'))) {
    const jobId = extractValidExternalJobId(req.path);
    if (jobId) {
      const info = await resolveVideoInfoAsync(jobId);
      if (info) {
        req.resolvedVideoInfo = info;
        return next();
      }
    }
  }

  return sendPrivatePortalLocked(req, res);
});

app.get('/videos/:idOrToken.mp4', async (req, res) => {
  const info = req.resolvedVideoInfo || await resolveVideoInfoAsync(req.params.idOrToken);
  if (!info) return sendPrivatePortalLocked(req, res);
  if (info.hasLocalVideo && info.localVideoPath && fs.existsSync(info.localVideoPath)) {
    return res.sendFile(info.localVideoPath);
  }

  // Check on-disk cache for fast local delivery
  const cachedVideoFile = path.join(tmpVideoDir, `${info.shareId}.mp4`);
  if (fs.existsSync(cachedVideoFile)) {
    return res.sendFile(cachedVideoFile);
  }

  if (info.cloudMeta?.video_cdn_url) {
    const cdnUrl = info.cloudMeta.video_cdn_url;
    try {
      const headers = {};
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }
      const remoteResp = await fetch(cdnUrl, { headers });
      if (!remoteResp.ok && remoteResp.status !== 206) {
        return res.status(remoteResp.status).end();
      }

      res.status(remoteResp.status);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');

      if (remoteResp.headers.get('content-range')) {
        res.setHeader('Content-Range', remoteResp.headers.get('content-range'));
      }
      if (remoteResp.headers.get('content-length')) {
        res.setHeader('Content-Length', remoteResp.headers.get('content-length'));
      }

      // Cache file locally in background if this was a full (non-range) request
      if (!req.headers.range && !fs.existsSync(cachedVideoFile)) {
        fetch(cdnUrl)
          .then(r => r.arrayBuffer())
          .then(buf => fs.promises.writeFile(cachedVideoFile, Buffer.from(buf)))
          .catch(() => {});
      }

      const nodeStream = Readable.fromWeb(remoteResp.body);
      return nodeStream.pipe(res);
    } catch (streamErr) {
      console.error('[Video-Stream] Proxy error:', streamErr.message);
      return res.redirect(302, cdnUrl);
    }
  }
  return res.status(404).end();
});

app.get('/thumbnails/:idOrToken.jpg', async (req, res) => {
  const info = req.resolvedVideoInfo || await resolveVideoInfoAsync(req.params.idOrToken);
  if (!info) return sendPrivatePortalLocked(req, res);
  if (info.localThumbPath && fs.existsSync(info.localThumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(info.localThumbPath);
  }

  const cachedThumbFile = path.join(tmpVideoDir, `${info.shareId}.jpg`);
  if (fs.existsSync(cachedThumbFile)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cachedThumbFile);
  }

  if (info.cloudMeta?.thumb_cdn_url) {
    const cdnUrl = info.cloudMeta.thumb_cdn_url;
    try {
      const remoteResp = await fetch(cdnUrl);
      if (remoteResp.ok) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        fetch(cdnUrl)
          .then(r => r.arrayBuffer())
          .then(buf => fs.promises.writeFile(cachedThumbFile, Buffer.from(buf)))
          .catch(() => {});

        const nodeStream = Readable.fromWeb(remoteResp.body);
        return nodeStream.pipe(res);
      }
    } catch {}
    return res.redirect(302, cdnUrl);
  }

  const fallbackThumb = path.join(thumbsDir, '2122421990107900101.jpg');
  if (fs.existsSync(fallbackThumb)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(fallbackThumb);
  }
  return res.status(404).end();
});

app.get('/oembed', async (req, res) => {
  const rawUrl = String(req.query.url || '');
  const cleanPath = rawUrl.split('?')[0].split('/').filter(Boolean).pop() || '';
  const info = await resolveVideoInfoAsync(cleanPath);
  const realJobId = info?.jobId || '2122421990107900101';
  const outToken = info ? cleanPath : getShareHash(realJobId);

  const protocol = req.headers['x-forwarded-proto'] || (req.headers['cf-connecting-ip'] ? 'https' : req.protocol) || 'https';
  const baseUrl = `${protocol}://${req.get('host')}`;
  const title = info?.title || 'Quick Video for Your Project';
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
    const info = req.resolvedVideoInfo || await resolveVideoInfoAsync(req.params.jobId);
    if (!info) {
      return sendPrivatePortalLocked(req, res);
    }
    const realJobId = info.jobId;
    let job = info.job || db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(realJobId);
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
        title: info.title || 'Software & Automation Requirements',
        client_country: info.clientCountry || 'United States',
        client_hire_rate: 100
      };
    }
    const videoReady = Boolean(info.hasLocalVideo || info.cloudMeta?.video_cdn_url);
    if (!videoReady && !IS_RENDER_CLOUD) {
      ensureVideoGenerated(realJobId, false).catch(() => {});
    }
    const visitorTz = await detectVisitorTimezone(req);
    res.json({
      ...job,
      job_id: realJobId,
      share_id: info.shareId || getShareHash(realJobId),
      video_url: `/videos/${req.params.jobId}.mp4`,
      video_ready: videoReady,
      visitor_tz: visitorTz
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Record Client Call Booking (ToS-compliant, zero email/form required)
app.post('/api/book-call/:jobId', async (req, res) => {
  try {
    const vInfo = req.resolvedVideoInfo || await resolveVideoInfoAsync(req.params.jobId);
    if (!vInfo) {
      return sendPrivatePortalLocked(req, res);
    }
    const realJobId = vInfo.jobId;

    const { selected_date, selected_time, visitor_timezone, client_note } = req.body || {};
    if (!selected_date || !selected_time) {
      return res.status(400).json({ ok: false, error: 'selected_date and selected_time are required' });
    }

    const jobTitle = vInfo.title || 'Upwork Project';
    const shareId = vInfo.shareId || getShareHash(realJobId);
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
    const publicBaseUrl = process.env.PUBLIC_LOOM_URL || 'https://loom.sametcankoksoy.com';
    sendBookingEmail({
      jobId: realJobId,
      jobTitle,
      selectedDate: selected_date,
      selectedTime: selected_time,
      visitorTimezone: visitor_timezone,
      visitorIp,
      clientNote: client_note,
      shareUrl: `${publicBaseUrl}/share/${shareId}`
    }).catch(err => console.error('[Email-Notifier] Booking email error:', err.message));
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

function notifyDesktopAndTelegram({ logTag = 'NOTIFY', title, subtitle, bodyText, shareUrl }) {
  console.log(`[${logTag}] ${title} | ${subtitle} | ${bodyText}`);
  showWindowsBalloon(title, `${subtitle}\n${bodyText}`);

  const linkBlock = shareUrl ? `\n\n👉 <a href="${shareUrl}">Click here to watch video</a>` : '';
  const msg = `<b>${escapeTgHtml(title)}</b>\n${escapeTgHtml(subtitle)}\n${escapeTgHtml(bodyText)}${linkBlock}`;
  sendTelegramMessage(msg, {
    parseMode: 'HTML',
    disablePreview: true,
    ...(shareUrl ? {
      replyMarkup: {
        inline_keyboard: [[{ text: '🎥 Click here to watch video', url: shareUrl }]]
      }
    } : {})
  }).catch(() => {});
}

function notifyVideoActivity({ title, subtitle, bodyText, shareUrl }) {
  notifyDesktopAndTelegram({ logTag: 'VIDEO WATCHED', title, subtitle, bodyText, shareUrl });
}

function formatClientDetailedSummary(job) {
  const fullJob = (job?.job_id ? db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) : null) || job || {};
  const isVerified = Boolean(fullJob.client_payment_verified);
  const verifiedText = isVerified ? 'True (✅ Onaylı)' : 'False (⚠️ Onaysız)';
  const country = fullJob.client_country || 'Unknown';
  const totalHires = Number(fullJob.client_total_hires || 0);
  const totalPosted = Number(fullJob.client_total_posted || 0);
  const hireRate = Number(fullJob.client_hire_rate || 0);
  const totalSpent = Number(fullJob.client_total_spent || 0);
  const rating = Number(fullJob.client_rating || 0);

  const spentFormatted = totalSpent >= 1000
    ? `$${Math.round(totalSpent).toLocaleString('en-US')}`
    : `$${Math.round(totalSpent)}`;

  const avgSpent = totalHires > 0 ? Math.round(totalSpent / totalHires) : 0;
  const avgFormatted = avgSpent > 0
    ? `$${avgSpent.toLocaleString('en-US')} / kişi`
    : 'N/A';

  let maxPaidFormatted = 'N/A';
  if (totalHires === 1 && totalSpent > 0) {
    maxPaidFormatted = `$${Math.round(totalSpent).toLocaleString('en-US')} (Tek iş)`;
  } else if (fullJob.client_max_paid && Number(fullJob.client_max_paid) > 0) {
    maxPaidFormatted = `$${Math.round(Number(fullJob.client_max_paid)).toLocaleString('en-US')}`;
  } else if (totalHires > 1 && totalSpent > 0) {
    maxPaidFormatted = `~$${Math.round(Math.max(avgSpent * 2.2, totalSpent * 0.2)).toLocaleString('en-US')} (Tahmini en büyük)`;
  }

  return [
    `🌍 <b>Client Country:</b> ${escapeTgHtml(country)}${rating > 0 ? ` (⭐ ${rating.toFixed(1)})` : ''}`,
    `💳 <b>Payment Verified:</b> <code>${verifiedText}</code>`,
    `🤝 <b>Kaç Kişi Hire Etmiş:</b> <b>${totalHires} kişi</b>${totalPosted > 0 ? ` (${totalPosted} ilanda %${hireRate} hire rate)` : ''}`,
    `💰 <b>Toplam Harcama:</b> <b>${spentFormatted}</b>`,
    `📊 <b>Ortalama Ödeme:</b> <b>${avgFormatted}</b>`,
    `🔝 <b>En Çok Ödediği Kişi:</b> <b>${maxPaidFormatted}</b>`
  ].join('\n');
}

setProposalNotificationHandler(async ({ job, shareUrl, chargedAmount, connectsCost }) => {
  const cleanId = String(job?.job_id || '').trim().replace(/^~?02/, '');
  const rateLabel = (job?.job_type || '').toLowerCase() === 'hourly' ? `$${chargedAmount}/hr` : `$${chargedAmount}`;
  const upworkUrl = `https://www.upwork.com/jobs/~02${cleanId}`;
  const clientBlock = formatClientDetailedSummary(job);

  const text = `🔥 <b>New Proposal Submitted!</b>\n\n` +
    `📌 <b>Job:</b> <a href="${upworkUrl}">${escapeTgHtml(job?.title || 'Upwork Job')}</a>\n` +
    `💰 <b>Rate:</b> ${rateLabel} | <b>Connects:</b> ${connectsCost || 0} (Boost: 0)\n\n` +
    `📋 <b>Client Profili & Harcama Detayları:</b>\n` +
    `${clientBlock}\n\n` +
    `👉 <a href="${shareUrl}">Click here to watch video</a>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🎥 Click here to watch video', url: shareUrl }
      ],
      [
        { text: '💼 View Job on Upwork', url: upworkUrl }
      ]
    ]
  };

  await sendTelegramMessage(text, { replyMarkup: inlineKeyboard, disablePreview: false });
  showWindowsBalloon('🔥 New Proposal Submitted!', `${job?.title || ''}\n${rateLabel} | ${connectsCost} Connects`);
});

function buildUpworkApplyUrl(jobId) {
  const cleanId = String(jobId || '').trim().replace(/^~?02/, '');
  return `https://www.upwork.com/ab/proposals/job/~02${cleanId}/apply/`;
}

setProposalFallbackHandler(async ({ job, coverLetter, shareUrl, chargedAmount, connectsCost, error }) => {
  const cleanId = String(job?.job_id || '').trim().replace(/^~?02/, '');
  const rateLabel = (job?.job_type || '').toLowerCase() === 'hourly' ? `$${chargedAmount}/hr` : `$${chargedAmount}`;
  const applyUrl = buildUpworkApplyUrl(job?.job_id);
  const errSummary = String(typeof error === 'object' ? JSON.stringify(error) : (error || 'UNEXPECTED_ERROR')).slice(0, 180);
  const clientBlock = formatClientDetailedSummary(job);

  console.log(`[AUTO-PROPOSAL FALLBACK] Job ${job?.job_id} | Dispatching 1-Click Apply + MCP Approve button to Telegram`);
  showWindowsBalloon('⚠️ Upwork Proposal Ready (1-Click)', `${job?.title || job?.job_id}\n1-Click application & MCP retry sent to Telegram.`);

  const text = `⚡ <b>Proposal Ready — 1-Click Apply</b>\n\n` +
    `📌 <b>Job:</b> ${escapeTgHtml(job?.title || job?.job_id)}\n` +
    `💰 <b>Rate:</b> ${rateLabel}${connectsCost ? ` | <b>Connects:</b> ${connectsCost}` : ''}\n` +
    `⚠️ <b>MCP Status:</b> <code>${escapeTgHtml(errSummary)}</code>\n\n` +
    `📋 <b>Client Profili & Harcama Detayları:</b>\n` +
    `${clientBlock}\n\n` +
    `📝 <b>Cover Letter (Tap to copy):</b>\n` +
    `<code>${escapeTgHtml(coverLetter || '')}</code>\n\n` +
    `👉 <a href="${shareUrl}">Click here to watch video</a>\n\n` +
    `👇 <i>Tap 1-Click Apply to submit safely in your browser, or tap Approve &amp; Retry MCP once cooldown clears.</i>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🚀 1-Click Apply on Upwork', url: applyUrl }
      ],
      [
        { text: '✅ Approve & Retry via MCP', callback_data: `mcp_retry:${cleanId}` },
        { text: '🎥 Click here to watch video', url: shareUrl }
      ]
    ]
  };

  await sendTelegramMessage(text, { replyMarkup: inlineKeyboard });
});

async function buildLiveStatusMessage(header = '🤖 <b>Upwork Automation Live Status</b>', extraLines = []) {
  const mcpRadarOn = getSetting('upwork_mcp_radar_enabled') === true;
  const intervalMin = Math.round(Math.max(120000, Number(getSetting('mcp_radar_interval_ms') || 120000)) / 60000);
  const autoPropOn = getSetting('auto_proposer_enabled') !== false;
  const dailyCount = getDailySubmittedCount();
  const maxDaily = Number(getSetting('daily_proposal_limit') ?? 5);
  const freezeUntil = Number(getSetting('mcp_freeze_until') || 0);
  const isFrozen = freezeUntil > Date.now();
  const minsLeft = isFrozen ? Math.max(1, Math.ceil((freezeUntil - Date.now()) / 60000)) : 0;
  const freezeRemainingLabel = minsLeft >= 60
    ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`
    : `${minsLeft}m`;
  const lastFlc = db.prepare(`SELECT started_at, status, details FROM bot_runs WHERE run_type = 'flconsole_mcp_sync' ORDER BY id DESC LIMIT 1`).get();

  let cooldownText = isFrozen ? `❄️ Frozen for ${freezeRemainingLabel} (resting Upwork MCP)` : 'Unknown (no token)';
  let connectsText = 'N/A';

  if (!isFrozen) {
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
            cooldownText = `⏳ STILL ACTIVE (${String(e.message || '').slice(0, 90)})`;
          }
        }
      }
    } catch (e) {
      cooldownText = `Error: ${e.message}`;
    }
  }

  const flcEnabled = getSetting('flconsole_sync_enabled') === true;
  const lines = [
    header,
    '',
    `• <b>Direct Upwork MCP Radar:</b> ${isFrozen ? `❄️ Frozen (${freezeRemainingLabel} left → resumes every ${intervalMin}m)` : (mcpRadarOn ? `✅ Active (every ${intervalMin} min)` : '🛡️ PAUSED')}`,
    `• <b>flconsole Sync:</b> ${flcEnabled ? `✅ Active (${escapeTgHtml(lastFlc?.details || 'waiting')})` : '⛔ Disabled (Direct MCP Mode)'}`,
    `• <b>Auto-Proposer (0 Boost, Auto-Confirm):</b> ${isFrozen ? `❄️ Frozen (${freezeRemainingLabel} left)` : (autoPropOn ? '✅ Enabled' : '⏸️ Paused')} (${dailyCount}/${maxDaily} today)`,
    `• <b>Connects Balance:</b> ${connectsText}`,
    `• <b>Upwork Cooldown Check:</b> ${escapeTgHtml(cooldownText)}`,
    ...extraLines,
    '',
    `<i>Commands: /status · /pause_auto · /resume_auto</i>`
  ];
  return lines.join('\n');
}

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
    const msg = await buildLiveStatusMessage();
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

// Consolidated Watch Session Tracker: avoids notification spam by aggregating viewing activity per visitor
const activeWatchSessions = new Map();

function getOrCreateWatchSession({ realJobId, jobTitle, jobClientCountry, shareId, shareUrl, visitorLocation, visitorTimezone, tzInfo, visitorIp, userAgent }) {
  const sessionKey = `${realJobId}_${visitorIp || 'anon'}`;
  let session = activeWatchSessions.get(sessionKey);
  if (!session) {
    session = {
      key: sessionKey,
      jobId: realJobId,
      jobTitle,
      jobClientCountry,
      shareId,
      shareUrl,
      visitorLocation,
      visitorTimezone,
      visitorCountry: tzInfo?.country || '',
      visitorCity: tzInfo?.city || '',
      visitorRegion: tzInfo?.region || '',
      utcOffset: tzInfo?.utc_offset || '',
      visitorIp,
      userAgent,
      maxPercent: 0,
      maxSeconds: 0,
      hasPlayed: false,
      hasCompleted: false,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      timer: null,
      notifiedPercent: -1
    };
    activeWatchSessions.set(sessionKey, session);
  } else {
    session.lastSeenAt = Date.now();
    if (jobTitle && (!session.jobTitle || session.jobTitle.startsWith('Upwork Job ('))) session.jobTitle = jobTitle;
    if (visitorLocation && session.visitorLocation === 'Unknown Location') session.visitorLocation = visitorLocation;
  }
  return session;
}

async function dispatchConsolidatedWatchAlert(session) {
  if (!session) return;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }

  // Prevent duplicate spam if watch percent did not increase meaningfully (+15% or to 100%)
  if (session.notifiedPercent >= 0) {
    if (session.maxPercent <= session.notifiedPercent) return;
    if (session.maxPercent < 95 && (session.maxPercent - session.notifiedPercent) < 15) return;
  }
  session.notifiedPercent = session.maxPercent;

  const pct = session.maxPercent;
  const isWatched = pct > 0 || session.hasPlayed;
  const actionText = isWatched
    ? `client opened proposal page and watched ${pct}% of video`
    : `client opened proposal page (did not play video)`;

  console.log(`[WATCH CONSOLIDATED] Job ${session.jobId} | ${actionText} | ${session.visitorLocation} | ${session.maxSeconds}s`);

  // 1. Telegram Alert with clickable link & inline button
  const cleanId = String(session.jobId || '').trim().replace(/^~?02/, '');
  const upworkUrl = `https://www.upwork.com/jobs/~02${cleanId}`;
  const jobRow = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(session.jobId);
  const clientBlock = jobRow ? `\n\n📋 <b>Client Detayları:</b>\n` + formatClientDetailedSummary(jobRow) : '';

  const tgText = `👁️ <b>Client Activity on Proposal</b>\n\n` +
    `📌 <b>Job:</b> <a href="${upworkUrl}">${escapeTgHtml(session.jobTitle)}</a>\n` +
    `👤 <b>${escapeTgHtml(actionText)}</b>\n` +
    `📍 <b>Location:</b> ${escapeTgHtml(session.visitorLocation)}${session.utcOffset ? ` (${escapeTgHtml(session.utcOffset)})` : ''}\n` +
    `⏱️ <b>Watch Duration:</b> ${session.maxSeconds}s` +
    `${clientBlock}\n\n` +
    `👉 <a href="${session.shareUrl}">Click here to watch video</a>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🎥 Click here to watch video', url: session.shareUrl }
      ],
      [
        { text: '💼 View Job on Upwork', url: upworkUrl }
      ]
    ]
  };

  sendTelegramMessage(tgText, { replyMarkup: inlineKeyboard, disablePreview: false }).catch(() => {});
  showWindowsBalloon('👁️ Client Video Activity', `${actionText}\n${session.jobTitle}`);

  // 2. Consolidated Email Alert via Resend / SMTP
  sendVideoWatchEmail({
    jobId: session.jobId,
    jobTitle: session.jobTitle,
    jobClientCountry: session.jobClientCountry,
    eventType: isWatched ? (pct >= 95 ? 'video_completed' : 'video_50pct') : 'page_open',
    eventLabel: actionText,
    watchSeconds: session.maxSeconds,
    visitorCountry: session.visitorCountry,
    visitorCity: session.visitorCity,
    visitorRegion: session.visitorRegion,
    visitorLocation: session.visitorLocation,
    visitorTimezone: session.visitorTimezone,
    utcOffset: session.utcOffset,
    visitorIp: session.visitorIp,
    userAgent: session.userAgent,
    shareUrl: session.shareUrl
  }).then(r => {
    if (r?.ok) console.log(`[Email-Notifier] Consolidated watch email sent for ${session.jobId} (${actionText})`);
  }).catch(err => console.error('[Email-Notifier] Watch email error:', err.message));

  setTimeout(() => {
    activeWatchSessions.delete(session.key);
  }, 30 * 60 * 1000);
}

// API: Real-Time Video Watch Tracking & Notifications
app.post('/api/track-view/:jobId', async (req, res) => {
  try {
    const userAgent = String(req.headers['user-agent'] || '');
    if (/(TelegramBot|Slackbot|Discordbot|Twitterbot|facebookexternalhit|LinkedInBot|WhatsApp)/i.test(userAgent)) {
      return res.json({ ok: true, ignored: 'bot' });
    }

    const vInfo = req.resolvedVideoInfo || await resolveVideoInfoAsync(req.params.jobId);
    if (!vInfo) {
      return sendPrivatePortalLocked(req, res);
    }
    const realJobId = vInfo.jobId;

    const allowedEvents = new Set(['page_open', 'video_play', 'video_progress', 'video_pause', 'video_50pct', 'video_completed', 'page_leave']);
    const eventType = allowedEvents.has(req.body?.event_type) ? req.body.event_type : 'page_open';
    const watchSeconds = Math.max(0, Math.round(Number(req.body?.watch_seconds || 0)));
    const watchPercent = Math.min(100, Math.max(0, Math.round(Number(req.body?.watch_percent || 0))));

    const jobTitle = vInfo.title || `Upwork Job (${realJobId})`;
    const jobClientCountry = vInfo.clientCountry || '';
    const shareId = vInfo.shareId || getShareHash(realJobId);
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

    const publicBaseUrl = process.env.PUBLIC_LOOM_URL || 'https://loom.sametcankoksoy.com';
    const shareUrl = `${publicBaseUrl}/share/${shareId}`;

    const session = getOrCreateWatchSession({
      realJobId,
      jobTitle,
      jobClientCountry,
      shareId,
      shareUrl,
      visitorLocation,
      visitorTimezone,
      tzInfo,
      visitorIp: String(visitorIp),
      userAgent
    });

    session.maxSeconds = Math.max(session.maxSeconds, watchSeconds);
    session.maxPercent = Math.max(session.maxPercent, watchPercent);
    if (eventType === 'video_play' || session.maxPercent > 0) {
      session.hasPlayed = true;
    }
    if (eventType === 'video_completed' || session.maxPercent >= 98) {
      session.hasCompleted = true;
      session.maxPercent = 100;
    }

    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    // If client finished the video (100%) or explicitly left the page, dispatch immediately
    if (session.hasCompleted || (eventType === 'page_leave' && session.maxPercent > 0)) {
      dispatchConsolidatedWatchAlert(session);
    } else {
      // Debounce: wait 12 seconds for client to finish or pause before sending single consolidated alert
      session.timer = setTimeout(() => {
        dispatchConsolidatedWatchAlert(session);
      }, 12000);
    }

    res.json({ ok: true, view_id: Number(info.lastInsertRowid), event_type: eventType, max_percent: session.maxPercent });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Local-only test email endpoint
app.post('/api/email/test', async (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(400).json({ ok: false, error: 'Email not configured yet. Set ALERT_EMAIL_TO + SMTP_USER/SMTP_PASS (or RESEND_API_KEY).' });
    }
    const result = await sendVideoWatchEmail({
      jobId: '2123838758892869262',
      jobTitle: 'Test Notification — Upwork Loom Video Watch Alert',
      eventType: 'video_play',
      eventLabel: 'Started Watching Video',
      watchSeconds: 18,
      visitorCountry: 'United States',
      visitorCity: 'New York',
      visitorRegion: 'NY',
      visitorLocation: 'New York, NY, United States',
      visitorTimezone: 'America/New_York',
      utcOffset: 'UTC-5',
      visitorIp: '127.0.0.1',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0',
      shareUrl: 'https://loom.sametcankoksoy.com/share/test'
    });
    res.json(result);
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
app.get(['/share/:jobId', '/loom/:jobId'], async (req, res) => {
  const vInfo = req.resolvedVideoInfo || await resolveVideoInfoAsync(req.params.jobId);
  if (!vInfo) {
    return sendPrivatePortalLocked(req, res);
  }

  const protocol = req.headers['x-forwarded-proto'] || (req.headers['cf-connecting-ip'] ? 'https' : req.protocol) || 'https';
  const baseUrl = `${protocol}://${req.get('host')}`;
  const rawTitle = vInfo.title ? vInfo.title : 'Quick Video for Your Project';
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
  res.json({
    status: 'ok',
    mode: IS_RENDER_CLOUD ? 'render_loom_portal_only' : 'local_mcp_engine',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Upwork Market Intelligence Server running on http://localhost:${PORT} (mode=${IS_RENDER_CLOUD ? 'render_loom_portal_only' : 'local_mcp_engine'})`);
  });

  if (IS_RENDER_CLOUD) {
    console.log('[Render-Portal] Cloud Portal-Only mode active. Upwork MCP radar, auto-proposer, flconsole, and Telegram polling are DISABLED on Render (strictly local PC only).');
    // Self keep-alive ping every 4 minutes so Render free tier stays warm for client Loom views
    const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://upwork-mcp-automation.onrender.com';
    setInterval(() => {
      fetch(`${externalUrl}/health`).catch(() => {});
    }, 4 * 60 * 1000);
  } else {
    // Safe Upwork MCP Radar loop: enforces >= 2 minute interval and strictly respects mcp_freeze_until cooldown windows.
    function scheduleNextUpworkMcpRadar(delayMs = 5000) {
      setTimeout(async () => {
        const intervalMs = Math.max(2 * 60 * 1000, Number(getSetting('mcp_radar_interval_ms') || 2 * 60 * 1000));
        let nextDelay = intervalMs;
        try {
          const freezeUntil = Number(getSetting('mcp_freeze_until') || 0);
          if (freezeUntil > Date.now()) {
            // Wait until freeze ends (+3s buffer) without touching Upwork MCP
            nextDelay = Math.min(intervalMs, Math.max(15000, (freezeUntil - Date.now()) + 3000));
          } else if (getSetting('upwork_mcp_radar_enabled') === true) {
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

    // Cooldown Freeze Wake-Up Watcher: automatically unfreezes after mcp_freeze_until, resumes 5-min radar + auto-proposer, and sends Telegram status report
    let freezeWakeupRunning = false;
    setInterval(async () => {
      if (freezeWakeupRunning) return;
      if (getSetting('mcp_freeze_report_pending') !== true) return;
      const freezeUntil = Number(getSetting('mcp_freeze_until') || 0);
      if (freezeUntil > Date.now()) return;

      freezeWakeupRunning = true;
      try {
        setSetting('mcp_freeze_report_pending', false);
        setSetting('mcp_freeze_until', 0);
        setSetting('upwork_mcp_radar_enabled', true);
        setSetting('auto_proposer_enabled', true);
        setSetting('mcp_freeze_report_sent_at', new Date().toISOString());

        console.log('[Cooldown-Wakeup] Cooldown complete. Resuming 5-min MCP radar & automatic proposals...');
        const radarRes = await runUpworkMcpRadarCycle().catch(e => ({ ok: false, error: e.message }));
        const autoRes = await runAutoProposerCycle(1).catch(e => ({ status: 'error', error: e.message }));

        const extra = [
          `• <b>Post-Freeze Radar Check:</b> ${radarRes?.ok ? `✅ OK (${radarRes.totalReturned || 0} jobs fetched, ${radarRes.newJobsFound || 0} new)` : `⚠️ ${escapeTgHtml(String(radarRes?.error || 'error').slice(0, 100))}`}`,
          `• <b>Auto-Proposal Check:</b> ${escapeTgHtml(autoRes?.status || 'checked')}${autoRes?.processed ? ` (processed=${autoRes.processed})` : ''}`
        ];

        const msg = await buildLiveStatusMessage('⏰ <b>24-Hour Cooldown Complete — Automation Resumed!</b>', extra);
        await sendTelegramMessage(msg);
        console.log('[Cooldown-Wakeup] Telegram status report dispatched.');
      } catch (err) {
        console.error('[Cooldown-Wakeup] Error:', err.message);
      } finally {
        freezeWakeupRunning = false;
      }
    }, 15 * 1000);

    // Start interactive Telegram bot (handles Approve & Retry MCP button + /status, /pause_auto, /resume_auto)
    startTelegramInteractiveBot();

    // Optional flconsole sync loop: DISABLED in Direct Upwork MCP mode (only runs if flconsole_sync_enabled === true)
    function scheduleNextFlconsoleSync(delayMs = 5000) {
      setTimeout(async () => {
        let nextDelay = 61 * 1000;
        try {
          if (getSetting('flconsole_sync_enabled') === true && getFlconsoleToken()) {
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

    scheduleNextFlconsoleSync(5000);

    // Realtime proposal watcher every 40 seconds (strictly respects Upwork MCP freeze & rate limit)
    setInterval(() => {
      runAutoProposerCycle(2).catch(err => console.error('[Auto-Proposer] Loop error:', err));
    }, 40 * 1000);
  }
}

module.exports = { app };
