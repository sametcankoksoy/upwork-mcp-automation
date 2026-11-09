const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'upwork_analytics.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for high concurrency
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE NOT NULL,
    category TEXT DEFAULT 'AI & Automation',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    keyword_matched TEXT,
    job_type TEXT DEFAULT 'Fixed', -- 'Fixed' or 'Hourly'
    budget REAL DEFAULT 0,
    hourly_min REAL DEFAULT 0,
    hourly_max REAL DEFAULT 0,
    posted_at TEXT NOT NULL,
    posted_hour_utc INTEGER NOT NULL,
    posted_day_of_week INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_checked_at TEXT NOT NULL,
    
    -- Client metrics at posting time
    client_country TEXT DEFAULT 'United States',
    client_total_spent REAL DEFAULT 0,
    client_hire_rate REAL DEFAULT 0, -- 0 to 100
    client_total_posted INTEGER DEFAULT 0,
    client_total_hires INTEGER DEFAULT 0,
    client_payment_verified INTEGER DEFAULT 1,
    client_rating REAL DEFAULT 0,

    -- Current / Latest Lifecycle Status
    current_proposals_tier TEXT DEFAULT 'Less than 5', -- 'Less than 5', '5 to 10', '10 to 15', '15 to 20', '20 to 50', '50+'
    current_proposals_numeric INTEGER DEFAULT 2,
    interviewing_count INTEGER DEFAULT 0,
    invites_sent INTEGER DEFAULT 0,
    unanswered_invites INTEGER DEFAULT 0,
    hires_count INTEGER DEFAULT 0,
    client_last_viewed_at TEXT,
    job_status TEXT DEFAULT 'open', -- 'open', 'hired', 'ghost', 'closed_no_hire'

    -- Computed Velocity & Lifecycle Metrics (in minutes)
    mins_to_5_10_proposals REAL,
    mins_to_10_15_proposals REAL,
    mins_to_20_plus_proposals REAL,
    mins_to_first_interview REAL,
    mins_to_hire REAL,
    is_ghost_job INTEGER DEFAULT 0,
    sniper_score INTEGER DEFAULT 50
  );

  CREATE TABLE IF NOT EXISTS job_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    mins_since_posted REAL NOT NULL,
    proposals_tier TEXT NOT NULL,
    proposals_numeric INTEGER NOT NULL,
    interviewing_count INTEGER DEFAULT 0,
    invites_sent INTEGER DEFAULT 0,
    unanswered_invites INTEGER DEFAULT 0,
    hires_count INTEGER DEFAULT 0,
    client_last_viewed_at TEXT,
    FOREIGN KEY (job_id) REFERENCES jobs(job_id)
  );

  CREATE TABLE IF NOT EXISTS bot_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT NOT NULL, -- 'discovery', 'snapshot_poll', 'mcp_sync'
    started_at TEXT NOT NULL,
    finished_at TEXT,
    new_jobs_found INTEGER DEFAULT 0,
    jobs_updated INTEGER DEFAULT 0,
    status TEXT DEFAULT 'success',
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM auth_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setSetting(key, val) {
  db.prepare(`
    INSERT INTO auth_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(val));
}

// Seed user's exact specialized niche stack
const defaultKeywords = [
  ['Playwright', 'Browser Automation'],
  ['Selenium', 'Browser Automation'],
  ['Browser Automation', 'Browser Automation'],
  ['Web Scraping', 'Website Scraping'],
  ['AI Agent', 'AI & Agents'],
  ['AI Automation', 'AI & Agents'],
  ['Automation Script', 'Scripting & Automation'],
  ['Python Automation', 'Scripting & Automation'],
  ['Full-Stack Development', 'Full-Stack & Backend'],
  ['Node.js', 'Full-Stack & Backend'],
  ['Automation', 'Scripting & Automation'],
  ['LLM', 'AI & Agents']
];
const insertKw = db.prepare('INSERT OR IGNORE INTO tracked_keywords (keyword, category, active) VALUES (?, ?, 1)');
for (const [kw, cat] of defaultKeywords) {
  insertKw.run(kw, cat);
}
db.exec(`UPDATE tracked_keywords SET active = 1 WHERE keyword IN (${defaultKeywords.map(k => `'${k[0]}'`).join(',')});`);
db.exec(`UPDATE tracked_keywords SET active = 0 WHERE keyword NOT IN (${defaultKeywords.map(k => `'${k[0]}'`).join(',')});`);

// Ensure flagship Loom showcase job is permanently available
db.prepare(`
  INSERT OR IGNORE INTO jobs (
    job_id, title, description, keyword_matched, job_type, budget, hourly_min, hourly_max,
    posted_at, posted_hour_utc, posted_day_of_week, first_seen_at, last_checked_at,
    client_country, client_total_spent, client_hire_rate, client_total_posted, client_total_hires,
    client_payment_verified, client_rating, current_proposals_tier, current_proposals_numeric,
    interviewing_count, invites_sent, unanswered_invites, hires_count, job_status, sniper_score
  ) VALUES (
    '2119487430141316904',
    'AI engineering consultant to audit how I build software with AI agents, top to bottom',
    'I run a small service business and I am not a professional engineer. Over the past few months I have built our operating software, a web and desktop app the team uses every day, almost entirely with AI coding agents. It works and we depend on it heavily, but I need a senior AI engineer to audit the architecture, data security, error handling, and deployment pipeline.',
    'AI Automation',
    'Hourly',
    0, 45, 90,
    '2026-11-08T17:49:39.027Z',
    17, 0,
    '2026-11-08T18:14:38.933Z',
    '2026-11-08T21:41:48.700Z',
    'United States',
    62138.41,
    100, 29, 52, 1, 4.99,
    '20 to 50', 35, 0, 0, 0, 0, 'open', 75
  )
`).run();

// Clean up corrupted historical velocity values (> 180 mins recorded on old initial sync)
db.exec(`
  UPDATE jobs SET mins_to_5_10_proposals = NULL WHERE mins_to_5_10_proposals > 180;
  UPDATE jobs SET mins_to_10_15_proposals = NULL WHERE mins_to_10_15_proposals > 240;
`);

// Bootstrap tokens from UPWORK_TOKENS_JSON env var if running on Render/Cloud
if (process.env.UPWORK_TOKENS_JSON && !getSetting('upwork_tokens')) {
  try {
    const parsed = JSON.parse(process.env.UPWORK_TOKENS_JSON);
    setSetting('upwork_tokens', parsed);
    if (parsed.org_uid) setSetting('upwork_org_uid', parsed.org_uid);
  } catch (e) {
    console.error('Failed to parse UPWORK_TOKENS_JSON:', e.message);
  }
}

function tierToNumeric(tier) {
  if (!tier) return 2;
  const t = tier.toLowerCase();
  if (t.includes('less than 5') || t === '<5') return 3;
  if (t.includes('5 to 10') || t === '5-10') return 8;
  if (t.includes('10 to 15') || t === '10-15') return 13;
  if (t.includes('15 to 20') || t === '15-20') return 18;
  if (t.includes('20 to 50') || t === '20-50') return 35;
  if (t.includes('50+')) return 60;
  return parseInt(tier, 10) || 3;
}

function calculateSniperScore(job) {
  let score = 50;
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();

  // 1. Client Hire Rate & Track Record
  if (job.client_hire_rate >= 80) {
    score += 25;
  } else if (job.client_hire_rate >= 60) {
    score += 18;
  } else if (job.client_hire_rate < 35) {
    if (job.client_total_posted && job.client_total_posted >= 3) {
      score -= 30; // Habitual ghost client with zero hires
    } else if (!job.client_payment_verified) {
      score -= 20; // Unverified zero-history poster
    } else {
      score -= 8; // Fresh client with verified payment method
    }
  }

  // 2. Client Lifetime Spend
  if (job.client_total_spent >= 50000) score += 15;
  else if (job.client_total_spent >= 10000) score += 10;
  else if (job.client_total_spent >= 1000) score += 5;
  else if (job.client_total_spent === 0 && !job.client_payment_verified) score -= 20;

  // 3. User Stack Alignment Boost (+20)
  // Target: Automation, AI Agent, Website Scraping, Playwright, Selenium, Browser Automation, Python, Node.js, Automation Script
  const isHighFitStack = /(playwright|selenium|browser automation|puppeteer|anti-bot|cloudflare|stealth|crawler|web scraping|scrape|website scraper|ai agent|agentic|llm|claude|langchain|llamaindex|automation script|python automation|python script|node\.js|full-stack|full stack)/i.test(text);
  if (isHighFitStack) {
    score += 20;
  }

  // 4. Low-Quality Lead Scraping Penalty (-40)
  // User explicitly wants website scraping, NOT generic sales lead lists / cold email databases
  const isGenericLeadGen = /(b2b lead|lead gen|lead generation|email list|cold email|email outreach|apollo\.io|apollo|linkedin lead|yellow pages|google maps lead|contact list|lead scraper|data entry|virtual assistant|skip tracing)/i.test(text);
  if (isGenericLeadGen) {
    score -= 40;
  }

  // 4b. Unrelated Non-Dev Tasks Penalty (-35) (e.g. SEO, Social Media, Telemedicine Marketing)
  const isUnrelatedNonDev = /(seo, ads|marketing agency|social media|funnels|video editing|cold calling|sales rep|virtual assistant|copywriter|content writer|appointment setter|trading mentor)/i.test(text)
    && !/(playwright|selenium|scraping|crawler|puppeteer|browser automation|python|node\.js|full-stack|full stack)/i.test(text);
  if (isUnrelatedNonDev) {
    score -= 35;
  }

  // 5. Budget / Rate Alignment (Target: Sametcan $40/hr Top Rated)
  if (job.hourly_max >= 40 || job.budget >= 1500) score += 15;
  else if (job.hourly_max >= 30 || job.budget >= 400) score += 8;
  else if (job.budget > 0 && job.budget < 100) score -= 25;
  else if (job.hourly_max > 0 && job.hourly_max < 20) score -= 20;

  // 6. Competition Window
  const numProps = job.current_proposals_numeric || tierToNumeric(job.current_proposals_tier);
  if (numProps <= 5) score += 15;
  else if (numProps <= 10) score += 8;
  else if (numProps >= 35) score -= 15;

  // 7. Ghost Job Penalty
  if (job.is_ghost_job) score -= 40;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Refresh sniper scores across all existing jobs
try {
  const existingJobs = db.prepare('SELECT * FROM jobs').all();
  const updateScoreStmt = db.prepare('UPDATE jobs SET sniper_score = ? WHERE job_id = ?');
  for (const j of existingJobs) {
    const newScore = calculateSniperScore(j);
    if (newScore !== j.sniper_score) {
      updateScoreStmt.run(newScore, j.job_id);
    }
  }
} catch (e) {
  console.error('Sniper score refresh error:', e.message);
}

function upsertJobAndSnapshot(jobData) {
  const existing = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobData.job_id);
  const nowIso = jobData.checked_at || new Date().toISOString();
  const postedDate = new Date(jobData.posted_at || nowIso);
  const checkedDate = new Date(nowIso);
  const minsSincePosted = Math.max(0, Math.round(((checkedDate - postedDate) / 60000) * 10) / 10);
  const proposalsNumeric = jobData.current_proposals_numeric || tierToNumeric(jobData.current_proposals_tier);

  if (!existing) {
    // Only record exact transition minutes if we caught the job reasonably fresh (<= 60 mins)
    // OR if it is currently still in that exact tier when first seen within 90 mins.
    // Otherwise leave null so old jobs discovered late don't pollute velocity averages with 1500+ min values!
    const caughtFresh = minsSincePosted <= 60;
    const minsTo5_10 = (caughtFresh && proposalsNumeric >= 6) || (minsSincePosted <= 90 && proposalsNumeric >= 6 && proposalsNumeric <= 10)
      ? minsSincePosted
      : null;
    const minsTo10_15 = (caughtFresh && proposalsNumeric >= 11) || (minsSincePosted <= 120 && proposalsNumeric >= 11 && proposalsNumeric <= 15)
      ? minsSincePosted
      : null;
    const minsTo20Plus = (caughtFresh && proposalsNumeric >= 20) || (minsSincePosted <= 180 && proposalsNumeric >= 20)
      ? minsSincePosted
      : null;
    const minsToInterview = (caughtFresh && (jobData.interviewing_count || 0) > 0) ? minsSincePosted : null;
    const minsToHire = (minsSincePosted <= 1440 && (jobData.hires_count || 0) > 0) ? minsSincePosted : null;

    // Ghost detection heuristic: >24h old, 0 hires, 0 interviews, or client hasn't viewed in >18h
    const isGhost = jobData.is_ghost_job !== undefined
      ? (jobData.is_ghost_job ? 1 : 0)
      : (minsSincePosted > 1440 && (jobData.hires_count || 0) === 0 && (jobData.interviewing_count || 0) === 0 ? 1 : 0);

    const status = (jobData.hires_count || 0) > 0
      ? 'hired'
      : (isGhost ? 'ghost' : (jobData.job_status || 'open'));

    const sniperScore = calculateSniperScore({
      ...jobData,
      current_proposals_numeric: proposalsNumeric,
      is_ghost_job: isGhost
    });

    db.prepare(`
      INSERT INTO jobs (
        job_id, title, description, keyword_matched, job_type, budget, hourly_min, hourly_max,
        posted_at, posted_hour_utc, posted_day_of_week, first_seen_at, last_checked_at,
        client_country, client_total_spent, client_hire_rate, client_total_posted, client_total_hires,
        client_payment_verified, client_rating,
        current_proposals_tier, current_proposals_numeric, interviewing_count, invites_sent, unanswered_invites,
        hires_count, client_last_viewed_at, job_status,
        mins_to_5_10_proposals, mins_to_10_15_proposals, mins_to_20_plus_proposals,
        mins_to_first_interview, mins_to_hire, is_ghost_job, sniper_score
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      jobData.job_id,
      jobData.title,
      jobData.description || '',
      jobData.keyword_matched || 'AI Automation',
      jobData.job_type || 'Fixed',
      jobData.budget || 0,
      jobData.hourly_min || 0,
      jobData.hourly_max || 0,
      postedDate.toISOString(),
      postedDate.getUTCHours(),
      postedDate.getUTCDay(),
      nowIso,
      nowIso,
      jobData.client_country || 'United States',
      jobData.client_total_spent || 0,
      jobData.client_hire_rate || 0,
      jobData.client_total_posted || 1,
      jobData.client_total_hires || 0,
      jobData.client_payment_verified !== undefined ? (jobData.client_payment_verified ? 1 : 0) : 1,
      jobData.client_rating || 4.9,
      jobData.current_proposals_tier || 'Less than 5',
      proposalsNumeric,
      jobData.interviewing_count || 0,
      jobData.invites_sent || 0,
      jobData.unanswered_invites || 0,
      jobData.hires_count || 0,
      jobData.client_last_viewed_at || null,
      status,
      jobData.mins_to_5_10_proposals !== undefined ? jobData.mins_to_5_10_proposals : minsTo5_10,
      jobData.mins_to_10_15_proposals !== undefined ? jobData.mins_to_10_15_proposals : minsTo10_15,
      jobData.mins_to_20_plus_proposals !== undefined ? jobData.mins_to_20_plus_proposals : minsTo20Plus,
      jobData.mins_to_first_interview !== undefined ? jobData.mins_to_first_interview : minsToInterview,
      jobData.mins_to_hire !== undefined ? jobData.mins_to_hire : minsToHire,
      isGhost,
      sniperScore
    );
  } else {
    // Update lifecycle transition timestamps if crossing thresholds for the first time
    const minsTo5_10 = existing.mins_to_5_10_proposals ?? (proposalsNumeric >= 6 ? minsSincePosted : null);
    const minsTo10_15 = existing.mins_to_10_15_proposals ?? (proposalsNumeric >= 11 ? minsSincePosted : null);
    const minsTo20Plus = existing.mins_to_20_plus_proposals ?? (proposalsNumeric >= 20 ? minsSincePosted : null);
    const minsToInterview = existing.mins_to_first_interview ?? ((jobData.interviewing_count || 0) > 0 ? minsSincePosted : null);
    const minsToHire = existing.mins_to_hire ?? ((jobData.hires_count || 0) > 0 ? minsSincePosted : null);

    const isGhost = jobData.is_ghost_job !== undefined
      ? (jobData.is_ghost_job ? 1 : 0)
      : (minsSincePosted > 1440 && (jobData.hires_count || 0) === 0 && (jobData.interviewing_count || 0) === 0 ? 1 : existing.is_ghost_job);

    const status = (jobData.hires_count || 0) > 0
      ? 'hired'
      : (isGhost ? 'ghost' : (jobData.job_status || existing.job_status));

    const sniperScore = calculateSniperScore({
      ...existing,
      ...jobData,
      current_proposals_numeric: proposalsNumeric,
      is_ghost_job: isGhost
    });

    db.prepare(`
      UPDATE jobs SET
        last_checked_at = ?,
        current_proposals_tier = ?,
        current_proposals_numeric = ?,
        interviewing_count = ?,
        invites_sent = ?,
        unanswered_invites = ?,
        hires_count = ?,
        client_last_viewed_at = COALESCE(?, client_last_viewed_at),
        job_status = ?,
        mins_to_5_10_proposals = ?,
        mins_to_10_15_proposals = ?,
        mins_to_20_plus_proposals = ?,
        mins_to_first_interview = ?,
        mins_to_hire = ?,
        is_ghost_job = ?,
        sniper_score = ?
      WHERE job_id = ?
    `).run(
      nowIso,
      jobData.current_proposals_tier || existing.current_proposals_tier,
      proposalsNumeric,
      jobData.interviewing_count ?? existing.interviewing_count,
      jobData.invites_sent ?? existing.invites_sent,
      jobData.unanswered_invites ?? existing.unanswered_invites,
      jobData.hires_count ?? existing.hires_count,
      jobData.client_last_viewed_at || null,
      status,
      minsTo5_10,
      minsTo10_15,
      minsTo20Plus,
      minsToInterview,
      minsToHire,
      isGhost,
      sniperScore,
      jobData.job_id
    );
  }

  // Record snapshot
  db.prepare(`
    INSERT INTO job_snapshots (
      job_id, checked_at, mins_since_posted, proposals_tier, proposals_numeric,
      interviewing_count, invites_sent, unanswered_invites, hires_count, client_last_viewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobData.job_id,
    nowIso,
    minsSincePosted,
    jobData.current_proposals_tier || 'Less than 5',
    proposalsNumeric,
    jobData.interviewing_count || 0,
    jobData.invites_sent || 0,
    jobData.unanswered_invites || 0,
    jobData.hires_count || 0,
    jobData.client_last_viewed_at || null
  );

  return !existing;
}

module.exports = {
  db,
  upsertJobAndSnapshot,
  tierToNumeric,
  calculateSniperScore,
  getSetting,
  setSetting
};
