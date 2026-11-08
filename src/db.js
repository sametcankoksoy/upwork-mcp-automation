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

// Seed default tracked keywords if empty
const defaultKeywords = [
  ['Automation', 'Core Niche'],
  ['Data Scraping', 'Core Niche'],
  ['AI Automation', 'Core Niche'],
  ['Full-Stack Development', 'Core Niche'],
  ['Back-End Development', 'Core Niche']
];
const insertKw = db.prepare('INSERT OR IGNORE INTO tracked_keywords (keyword, category, active) VALUES (?, ?, 1)');
for (const [kw, cat] of defaultKeywords) {
  insertKw.run(kw, cat);
}
// Deactivate old sub-niches unless explicitly added so we focus on the 5 core categories
db.exec(`UPDATE tracked_keywords SET active = 0 WHERE keyword IN ('n8n', 'Voice AI', 'Make.com', 'MCP Server', 'Web Scraping');`);

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
  // Client hire rate impact
  if (job.client_hire_rate >= 80) score += 25;
  else if (job.client_hire_rate >= 60) score += 18;
  else if (job.client_hire_rate < 35) score -= 25;

  // Client total spent impact
  if (job.client_total_spent >= 50000) score += 15;
  else if (job.client_total_spent >= 10000) score += 10;
  else if (job.client_total_spent === 0 && !job.client_payment_verified) score -= 20;

  // Budget impact
  if (job.budget >= 2000 || job.hourly_max >= 60) score += 12;
  else if (job.budget > 0 && job.budget < 200) score -= 15;

  // Competition impact
  const numProps = job.current_proposals_numeric || tierToNumeric(job.current_proposals_tier);
  if (numProps <= 5) score += 10;
  else if (numProps >= 35) score -= 15;

  // Ghost penalty
  if (job.is_ghost_job) score -= 40;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function upsertJobAndSnapshot(jobData) {
  const existing = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobData.job_id);
  const nowIso = jobData.checked_at || new Date().toISOString();
  const postedDate = new Date(jobData.posted_at || nowIso);
  const checkedDate = new Date(nowIso);
  const minsSincePosted = Math.max(0, Math.round(((checkedDate - postedDate) / 60000) * 10) / 10);
  const proposalsNumeric = jobData.current_proposals_numeric || tierToNumeric(jobData.current_proposals_tier);

  if (!existing) {
    const minsTo5_10 = proposalsNumeric >= 6 ? minsSincePosted : null;
    const minsTo10_15 = proposalsNumeric >= 11 ? minsSincePosted : null;
    const minsTo20Plus = proposalsNumeric >= 20 ? minsSincePosted : null;
    const minsToInterview = (jobData.interviewing_count || 0) > 0 ? minsSincePosted : null;
    const minsToHire = (jobData.hires_count || 0) > 0 ? minsSincePosted : null;

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
