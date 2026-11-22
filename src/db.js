const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'upwork_analytics.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for high concurrency & set busy_timeout to prevent 'database is locked' errors
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 10000;');

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

  CREATE TABLE IF NOT EXISTS call_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    share_id TEXT,
    job_title TEXT,
    selected_date TEXT NOT NULL,
    selected_time TEXT NOT NULL,
    visitor_timezone TEXT,
    visitor_ip TEXT,
    client_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auto_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT UNIQUE NOT NULL,
    job_title TEXT,
    share_id TEXT,
    share_url TEXT,
    charged_amount REAL,
    connects_cost INTEGER,
    status TEXT NOT NULL,
    preview_id TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS video_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    share_id TEXT,
    job_title TEXT,
    event_type TEXT NOT NULL,
    watch_seconds INTEGER DEFAULT 0,
    visitor_location TEXT,
    visitor_timezone TEXT,
    visitor_ip TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
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

if (getSetting('auto_proposer_enabled') === null) {
  setSetting('auto_proposer_enabled', true);
}

if (getSetting('daily_proposal_limit') === null) {
  setSetting('daily_proposal_limit', 10);
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
  if (t.includes('less than 5') || t.includes('fewer than 5') || t === '<5') return 3;
  if (t.includes('5 to 10') || t === '5-10') return 8;
  if (t.includes('10 to 15') || t === '10-15') return 13;
  if (t.includes('15 to 20') || t === '15-20') return 18;
  if (t.includes('20 to 50') || t === '20-50') return 35;
  if (t.includes('50+')) return 60;
  return parseInt(tier, 10) || 3;
}

const BLOCKED_COUNTRY_NAMES_RE = /\b(india|pakistan|bangladesh|sri lanka|nepal|nigeria|kenya|ghana|egypt|morocco|algeria|tunisia|uganda|tanzania|ethiopia|zimbabwe|zambia|cameroon|senegal|south africa|ivory coast|rwanda|botswana|namibia|mozambique|angola|sudan|somalia|libya|mali|niger|burkina faso|madagascar|malawi|benin|togo|sierra leone|liberia|congo|gabon|mauritius|philippines|vietnam|indonesia)\b/i;

const BLOCKED_COUNTRY_CODES_SET = new Set([
  'in', 'ind',
  'pk', 'pak',
  'bd', 'bgd',
  'lk', 'lka',
  'np', 'npl',
  'ng', 'nga',
  'ke', 'ken',
  'gh', 'gha',
  'eg', 'egy',
  'ma', 'mar',
  'dz', 'dza',
  'tn', 'tun',
  'ug', 'uga',
  'tz', 'tza',
  'et', 'eth',
  'zw', 'zwe',
  'zm', 'zmb',
  'cm', 'cmr',
  'sn', 'sen',
  'za', 'zaf',
  'ci', 'civ',
  'rw', 'rwa',
  'bw', 'bwa',
  'na', 'nam',
  'mz', 'moz',
  'ao', 'ago',
  'sd', 'sdn',
  'so', 'som',
  'ly', 'lby',
  'ml', 'mli',
  'ne', 'ner',
  'bf', 'bfa',
  'mg', 'mdg',
  'mw', 'mwi',
  'bj', 'ben',
  'tg', 'tgo',
  'sl', 'sle',
  'lr', 'lbr',
  'cg', 'cd', 'cog', 'cod',
  'ga', 'gab',
  'mu', 'mus',
  'ph', 'phl',
  'vn', 'vnm',
  'id', 'idn'
]);

function isBlockedClientCountry(country) {
  const c = String(country || '').trim().toLowerCase();
  if (!c) return false;
  if (BLOCKED_COUNTRY_CODES_SET.has(c)) return true;
  return BLOCKED_COUNTRY_NAMES_RE.test(c);
}

const BLOCKED_COUNTRIES_RE = BLOCKED_COUNTRY_NAMES_RE;

const US_COUNTRY_RE = /^(usa|us|united states|united states of america)$/i;
const TIER1_FIRST_POST_COUNTRIES_RE = /^(usa|us|united states|united states of america|uk|united kingdom|great britain|england|gbr|canada|can|australia|aus|austria|aut)$/i;
const WESTERN_COUNTRIES_RE = /^(usa|us|united states|united states of america|uk|united kingdom|great britain|england|gbr|canada|can|australia|aus|new zealand|nzl|germany|deu|switzerland|che|netherlands|nld|france|fra|sweden|swe|norway|nor|denmark|dnk|finland|fin|ireland|irl|austria|aut|belgium|bel|luxembourg|lux|spain|esp|italy|ita)$/i;

function isUsClientCountry(country) {
  return US_COUNTRY_RE.test(String(country || '').trim());
}

function isTier1FirstPostCountry(country) {
  return TIER1_FIRST_POST_COUNTRIES_RE.test(String(country || '').trim());
}

function isWesternClientCountry(country) {
  return WESTERN_COUNTRIES_RE.test(String(country || '').trim());
}

function isClientGeoAndHistoryEligible(job) {
  const country = String(job?.client_country || '').trim();
  if (isBlockedClientCountry(country)) return false;

  const isTier1 = isTier1FirstPostCountry(country);
  const isWestern = isWesternClientCountry(country);
  const verified = Boolean(job?.client_payment_verified);
  const posted = Number(job?.client_total_posted || 0);
  const spent = Number(job?.client_total_spent || 0);
  const hires = Number(job?.client_total_hires || 0);
  const hireRate = Number(job?.client_hire_rate || 0);

  // Rule 1: Tier-1 (US, Canada, UK, Australia, Austria) strictly 1st job only
  // Must be their VERY FIRST job post (posted <= 1, spent === 0, hires === 0, hireRate === 0)
  // Strictly rejects spam ghost posters with 2+ jobs and 0 spent/hires
  if (isTier1 && posted <= 1 && spent === 0 && hires === 0 && hireRate === 0) {
    return true;
  }

  // All other cases strictly require payment_verified
  if (!verified) return false;

  // Rule 2: Western payment-verified client who is NOT a habitual ghost-job poster
  if (isWestern) {
    if (posted <= 1 && spent === 0 && hires === 0 && hireRate === 0) return true;
    if (posted === 2 && hires >= 1) return true;
    return hireRate >= 50;
  }

  // Rule 3: Non-Western, non-blocked countries require verified + >= 60% hire rate
  return hireRate >= 60;
}

const LEAD_ENRICHMENT_RE = /\b(lead enrichment|enrich lead|enrich leads|b2b leads?|lead list|email list|contact list|cold email|apollo\.io|clay\.com|clayagent|linkedin leads?|yellow pages|skip tracing|extract contact information|email (?:address )?extraction|extract emails?|extract email addresses?|email scraper|scraping emails?)\b/i;

const STRICT_CORE_NICHE_RE = /\b(automate|automation|automated|workflow|workflows|n8n|make\.com|zapier|ai agents?|multi[- ]agent|agentic|\bmcp\b|chatbots?|chat bot|whatsapp bot|telegram bot|discord bot|slack bot|voice bot|phone bot|ai bot|custom bot|conversational ai|ai chat|rag agent|rag pipeline|rag|embeddings?|vector (?:search|db|database)|voice agent|voice ai|ai voice|vapi|retell|bland ai|twilio|elevenlabs|pipecat|livekit|phone agent|ai caller|ai receptionist|call automation|scrape|scraper|scrapers|scraping|web scraping|data scraping|data extraction|extract data|extracting|crawl|crawler|crawlers|crawling|playwright|selenium|puppeteer|cheerio|beautifulsoup|scrapy|browser automation|cloudflare bypass|anti-bot|python script|automation script|custom script|script developer|bot developer|bot development|python bot|python automation|api integration|webhook)\b/i;

function calculateSniperScore(job) {
  let score = 50;
  const titleText = String(job.title || '').toLowerCase();
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();

  // 1. Client Geo, Hire Rate & Non-Ghost Rules
  // Strictly 1st job only: posted <= 1, spent === 0, hires === 0, hireRate === 0
  const isTier1FirstPost = isTier1FirstPostCountry(job.client_country)
    && Number(job.client_total_posted || 0) <= 1
    && Number(job.client_total_spent || 0) === 0
    && Number(job.client_total_hires || 0) === 0
    && Number(job.client_hire_rate || 0) === 0;
  const isWesternVerifiedEligible = isWesternClientCountry(job.client_country)
    && Boolean(job.client_payment_verified)
    && isClientGeoAndHistoryEligible(job);

  if (job.client_hire_rate >= 80 && isClientGeoAndHistoryEligible(job)) {
    score += 25;
  } else if (isWesternVerifiedEligible) {
    score += 20;
  } else if (isTier1FirstPost) {
    score += 20;
  } else if (job.client_hire_rate >= 60 && isClientGeoAndHistoryEligible(job)) {
    score += 18;
  } else {
    score -= 30;
  }

  // 2. Client Lifetime Spend
  if (job.client_total_spent >= 50000) score += 15;
  else if (job.client_total_spent >= 10000) score += 10;
  else if (job.client_total_spent >= 1000) score += 5;
  else if (job.client_total_spent === 0 && !job.client_payment_verified && !isTier1FirstPost) score -= 20;

  // 3. User Stack Alignment Boost (+25)
  // Target: Automation, Chatbot, Voice Agent, Script, Data Scraping, Playwright, Selenium, AI Agent
  const isHighFitStack = /(playwright|selenium|browser automation|puppeteer|anti-bot|cloudflare|stealth|crawl|crawler|crawling|web scraping|data scraping|scrape|scrapers|scraping|website scraper|data extraction|extract data|voice agent|voice ai|vapi|retell|twilio|elevenlabs|pipecat|livekit|chatbot|whatsapp bot|telegram bot|discord bot|conversational ai|ai agent|agentic|llm|claude|openai|rag|\bmcp\b|langchain|llamaindex|automation script|python automation|python script|workflow automation|api automation|bot development|\bn8n\b|make\.com|zapier|node\.js|full-stack|full stack)/i.test(text);
  if (isHighFitStack || STRICT_CORE_NICHE_RE.test(text)) {
    score += 25;
  }

  // 4. Lead Enrichment, B2B Lead Lists & Manual Data Entry Penalty (-60)
  const isLeadEnrichmentOrList = LEAD_ENRICHMENT_RE.test(text) || /\b(data entry|virtual assistant)\b/i.test(text);
  if (isLeadEnrichmentOrList) {
    score -= 60;
  }

  // 4b. Unrelated Non-Dev Tasks Penalty (-45) (exempt if matching user's 5 core niches even in another industry/category)
  const isUnrelatedNonDev = /(seo, ads|marketing agency|social media|funnels|video edit(ing|ors?)|cold calling|sales rep|virtual assistant|copywriter|content writer|appointment setter|trading mentor|speakers?|voice actor|voice over|transcription|translator|translation|audio collection|survey respondent|data labeling|data annotation|annotate|accountant|accounting|bookkeep(er|ing)|tax preparer)/i.test(text)
    && !STRICT_CORE_NICHE_RE.test(text);
  if (isUnrelatedNonDev) {
    score -= 45;
  }

  // 5. Budget / Rate Alignment (Target: Sametcan $40/hr Top Rated)
  if (job.hourly_max >= 40 || job.budget >= 1500) score += 15;
  else if (job.hourly_max >= 30 || job.budget >= 400) score += 8;
  else if ((job.job_type || '').toLowerCase() === 'hourly' && Number(job.hourly_max || 0) === 0) score += 10;
  else if (job.budget > 0 && job.budget < 100) score -= 25;
  else if (job.hourly_max > 0 && job.hourly_max < 20) score -= 20;

  // 6. Competition Window
  const numProps = job.current_proposals_numeric || tierToNumeric(job.current_proposals_tier);
  if (numProps <= 5) score += 15;
  else if (numProps <= 10) score += 8;
  else if (numProps >= 35) score -= 15;

  // 7. Ghost Job Penalty
  if (job.is_ghost_job) score -= 40;

  // 4c. Consulting, Coaching, Mentoring, Audit-Only & Advisory Hard Cap (<= 30)
  // User strictly wants hands-on development/build projects, NOT consulting or coaching
  const isConsultingJob = /\b(consultant|consulting|consultation|advisor|advisory|coach|coaching|mentor|mentoring|mentorship|tutor|tutoring|trainer|training|auditor|code review|architecture review|strategy session|brainstorm|fractional cto|thought partner|teach me|walk me through)\b/i.test(titleText)
    || /\b(looking for a consultant|need a consultant|seeking a consultant|consulting call|advisory role|1-on-1 coaching|one-on-one coaching|teach me how|guide me through|no coding required|no development needed|just advice|consulting only|architecture audit|audit how i build|audit our)\b/i.test(text);
  if (isConsultingJob) {
    score = Math.min(score - 70, 30);
  }

  // 4d. Strictly reject WordPress, WooCommerce, Wix, Squarespace, CMS and Theme development
  // User note: We are NOT WordPress/CMS developers
  const isCmsOrWpJob = /\b(wordpress|woocommerce|wix|squarespace|shopify theme|drupal|magento|joomla|prestashop)\b/i.test(titleText)
    || /\b(wordpress (?:developer|expert|specialist|designer|coder|programmer|admin)|woocommerce (?:developer|expert)|wix (?:developer|expert)|squarespace (?:developer|expert))\b/i.test(text);
  if (isCmsOrWpJob) {
    score = Math.min(score - 85, 10);
  }

  // 4e. Game Development, Native Mobile & Off-Stack Hard Cap (<= 20)
  const isGameOrMobileHardware = /\b(game developer|game development|mobile games?|android games?|ios games?|3d games?|2d games?|video games?|playable|game engine|unity|unreal engine|unreal|godot|roblox|fivem|minecraft|gameplay|android developer|ios developer|kotlin|swift|objective-c|xcode|android studio|flutter|react native|embedded|firmware|arduino|blender|maya)\b/i.test(text);
  const isOffStackTitleRole = /(?:^|[^\w])(c\+\+|c#|\.net)(?!\w)|\b(dotnet|drupal|magento|laravel|ruby on rails|salesforce)\b/i.test(titleText)
    && !/\b(scrape|scraper|scraping|automation|automate|ai|agent|chatbot|voice|bot|n8n|script|python|playwright|selenium)\b/i.test(titleText);
  if (isGameOrMobileHardware || isOffStackTitleRole) {
    score = Math.min(score - 85, 20);
  }

  // 4e. QA Testing, Bug-Finder & Dedicated Tester Roles Hard Cap (<= 20)
  const isQaTitleRole = /\b(qa engineer|qa tester|qa automation|qa specialist|quality assurance|software tester|manual tester|manual testing|bug hunter|bug finder|find bugs|bug hunting|bug testing|sdet|penetration test(ing|er)?|pentest|usability testing|user testing)\b/i.test(titleText);
  const isQaOrBugTesting = isQaTitleRole || (
    /\b(qa engineer|qa tester|qa automation|quality assurance|manual testing|bug hunter|bug finder|find bugs|test cases|test plan|regression testing)\b/i.test(text)
    && !/\b(developer|dev\b|engineer|builder|architect|full-stack|full stack|backend|web scraping|scraper|ai agent|chatbot)\b/i.test(titleText)
  );
  if (isQaOrBugTesting) {
    score = Math.min(score - 85, 20);
  }

  // 4f. Strict 5-Niche Core Gate (Automation, Chatbot, Voice Agent, Script, Data Scraping ONLY; cap <= 35 otherwise)
  const leadSummary = `${titleText}\n${String(job.description || '').slice(0, 280).toLowerCase()}`;
  const isNonBuilderRole = /\b(solutions specialist|technical specialist|operations assistant|executive assistant|virtual assistant|project manager|product manager|delivery manager|program manager|scrum master|business analyst|system administrator|client success|customer success|account manager|sales rep|copywriter|content writer)\b/i.test(titleText);
  if (isNonBuilderRole || !STRICT_CORE_NICHE_RE.test(leadSummary)) {
    score = Math.min(score - 50, 35);
  }

  // 4g. Blocked Countries (Pakistan, India, Africa, etc.) Hard Zero Score (Never apply)
  if (isBlockedClientCountry(job.client_country)) {
    return 0;
  }
  if (!isClientGeoAndHistoryEligible(job)) {
    score = Math.min(score - 60, 25);
  }

  // 4h. Lead Enrichment / Contact List Hard Cap (<= 25)
  if (isLeadEnrichmentOrList) {
    score = Math.min(score - 60, 25);
  }

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

// Bootstrap historical dataset from seed_jobs.json if database has fewer than 20 jobs (e.g. fresh Render container deploys)
const seedJsonPath = path.join(dataDir, 'seed_jobs.json');
if (fs.existsSync(seedJsonPath)) {
  const currentCount = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  if (currentCount < 20) {
    try {
      const seedJobs = JSON.parse(fs.readFileSync(seedJsonPath, 'utf8'));
      console.log(`Bootstrapping ${seedJobs.length} historical jobs on Render/cloud into SQLite...`);
      for (const j of seedJobs) {
        upsertJobAndSnapshot(j);
      }
    } catch (e) {
      console.error('Failed to bootstrap seed_jobs.json:', e.message);
    }
  }
}

module.exports = {
  db,
  upsertJobAndSnapshot,
  tierToNumeric,
  calculateSniperScore,
  LEAD_ENRICHMENT_RE,
  STRICT_CORE_NICHE_RE,
  isBlockedClientCountry,
  isUsClientCountry,
  isTier1FirstPostCountry,
  isWesternClientCountry,
  isClientGeoAndHistoryEligible,
  getSetting,
  setSetting
};
