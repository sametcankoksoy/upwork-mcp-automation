const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
require('dotenv').config();

const { db, upsertJobAndSnapshot, getSetting } = require('./db');
const { getFullMarketAnalytics } = require('./analytics');
const { runTrackerCycle, UPWORK_MCP_URL } = require('./upwork-tracker');
const { createAuthorizationUrl, exchangeCodeForTokens, getValidAccessToken } = require('./upwork-oauth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Ensure public/videos directory exists and serve statically
const videosDir = path.join(__dirname, '..', 'public', 'videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}
app.use('/videos', express.static(videosDir));

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
    const result = await runTrackerCycle({ simulateStep: true });
    res.json({ ok: true, result });
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

// API: Single Job Details
app.get('/api/job/:jobId', (req, res) => {
  try {
    let job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(req.params.jobId);
    if (!job && req.params.jobId === '2119487430141316904') {
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
        job_id: req.params.jobId,
        title: 'Software & Automation Requirements',
        client_country: 'United States',
        client_hire_rate: 100
      };
    }
    const videoExists = fs.existsSync(path.join(videosDir, `${req.params.jobId}.mp4`));
    res.json({
      ...job,
      video_url: videoExists ? `/videos/${req.params.jobId}.mp4` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Generate Loom Video for a Job (SeleniumBase + MoviePy)
app.post('/api/generate-loom/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const scriptPath = path.join(__dirname, '..', 'scripts', 'stitch_loom_video.py');

  execFile('python', [scriptPath, '--job-id', jobId], { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Python video stitch error:', stderr || err.message);
      return res.status(500).json({ error: stderr || err.message });
    }
    const videoFile = `/videos/${jobId}.mp4`;
    const loomPage = `/loom/${jobId}`;
    const job = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
    const title = job?.title || 'your project';
    const proposalText = `Hey there,\n\nI saw your post regarding '${title}'. Instead of a long generic proposal, I recorded a quick 1-minute Loom video walking through your exact requirements and how I will execute this:\n\n👉 https://upwork-mcp-automation.onrender.com/loom/${jobId}\n\nLet me know what you think after watching, and we can discuss next steps!\n\nBest,\nSamet Can Koksoy`;

    res.json({
      ok: true,
      job_id: jobId,
      video_url: videoFile,
      loom_url: loomPage,
      proposal_text: proposalText
    });
  });
});

// Route: Loom View Player Page
app.get('/loom/:jobId', (req, res) => {
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

  // Initial sync on startup if connected
  setTimeout(() => {
    runTrackerCycle({ simulateStep: false }).catch(console.error);
  }, 5000);

  // Background polling timer every 5 minutes (safe rate limit)
  setInterval(() => {
    runTrackerCycle({ simulateStep: false }).catch(console.error);
  }, 5 * 60 * 1000);

  // Self keep-alive ping every 4 minutes
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://upwork-mcp-automation.onrender.com';
  setInterval(() => {
    fetch(`${externalUrl}/health`).catch(() => {});
  }, 4 * 60 * 1000);
}

module.exports = { app };
