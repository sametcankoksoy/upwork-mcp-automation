const dns = require('node:dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { db, getSetting, calculateSniperScore, LEAD_ENRICHMENT_RE, STRICT_CORE_NICHE_RE, isClientGeoAndHistoryEligible, isBlockedClientCountry, isWesternClientCountry } = require('./db');
const { getValidAccessToken } = require('./upwork-oauth');
const { callUpworkMcpTool, getTalentOrgUid } = require('./upwork-tracker');
const { evaluateJobFitWithAI } = require('./ai-evaluator');
const { uploadJobVideoToCloud } = require('./cloud-video-sync');

const execFileAsync = promisify(execFile);

const videosDir = path.join(__dirname, '..', 'public', 'videos');
const thumbsDir = path.join(__dirname, '..', 'public', 'thumbnails');
const renderScriptPath = path.join(__dirname, '..', 'scripts', 'render_video_generator.py');
const PUBLIC_BASE_URL = process.env.PUBLIC_LOOM_URL || 'https://loom.sametcankoksoy.com';

const TERMINAL_PROPOSAL_STATUSES = new Set([
  'submitted',
  'skipped_daily_limit_reached',
  'skipped_waiting_night_shift',
  'skipped_night_limit_reached',
  'skipped_not_core_sametlik',
  'skipped_ai_eval_rejected',
  'skipped_over_5_proposals',
  'skipped_over_10_proposals',
  'skipped_over_10_minutes',
  'skipped_private_listing',
  'skipped_already_applied',
  'skipped_already_hired',
  'skipped_consulting_or_non_dev',
  'skipped_low_hire_rate',
  'error_screening_answers',
  'error_confirm'
]);

const TRANSIENT_MCP_ERR_RE = /(fetch failed|econnreset|etimedout|socket hang up|\b502\b|\b503\b|\b504\b|could not read this job's payment terms|try again)/i;

let isProposerRunning = false;
let onProposalSubmitted = null;
let onProposalFallbackReady = null;
const activeVideoRenders = new Map();

function getCurrentTurkeyHour() {
  const now = new Date();
  const trDate = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  return trDate.getUTCHours();
}

function isAutoProposalWindowActive() {
  const windowEnabled = getSetting('auto_proposal_window_enabled') === true;
  if (!windowEnabled) return true; // 24/7 mode active by default

  const startHour = Number(getSetting('auto_proposal_window_start') ?? 0); // 0 = 00:00 (gece 12)
  const endHour = Number(getSetting('auto_proposal_window_end') ?? 6);     // 6 = 06:00 (sabah 6)
  const currentHour = getCurrentTurkeyHour();

  if (startHour <= endHour) {
    return currentHour >= startHour && currentHour < endHour;
  } else {
    return currentHour >= startHour || currentHour < endHour;
  }
}

function isNightShiftWindow() {
  return isAutoProposalWindowActive();
}

function getNightShiftSubmittedCount() {
  const row = db.prepare(`
    SELECT count(1) as cnt FROM auto_proposals
    WHERE status = 'submitted'
      AND date(created_at, '+3 hours') = date('now', '+3 hours')
      AND CAST(strftime('%H', created_at, '+3 hours') AS INTEGER) >= 0
      AND CAST(strftime('%H', created_at, '+3 hours') AS INTEGER) < 6
  `).get();
  return Number(row?.cnt || 0);
}

function getDailySubmittedCount() {
  const rowTr = db.prepare(`
    SELECT count(1) as cnt FROM auto_proposals
    WHERE status = 'submitted'
      AND date(created_at, '+3 hours') = date('now', '+3 hours')
  `).get();
  const row24h = db.prepare(`
    SELECT count(1) as cnt FROM auto_proposals
    WHERE status = 'submitted'
      AND datetime(created_at) >= datetime('now', '-24 hours')
  `).get();
  return Math.max(Number(rowTr?.cnt || 0), Number(row24h?.cnt || 0));
}

function isTamSametlikJob(job) {
  if (!job || !job.job_id) return false;
  if (isBlockedClientCountry(job.client_country)) return false;
  if (isConsultingOrNonBuildJob(job)) return false;
  if (!isClientGeoAndHistoryEligible(job)) return false;

  const text = `${job.title || ''}\n${job.description || ''}`;
  if (LEAD_ENRICHMENT_RE.test(text)) return false;

  // Reject pure CMS/SEO/Ads/Translation/Manual VA/Cold calling noise; let AI judge real engineering fit from full description
  if (/\b(wordpress|woocommerce|wix|squarespace|drupal|magento|joomla|prestashop|elementor|divi|webflow)\b/i.test(text)) {
    return false;
  }
  if (/\b(seo|sem|search engine optimization|google search console|semrush|ahrefs|keyword research|backlinks?|link building|hreflang|copywriting|copywriter|content writer|article writer|blog writer|translation|translator|meta ads|facebook ads|google ads|ppc specialist|media buyer)\b/i.test(text)) {
    return false;
  }
  if (/\b(virtual assistant|appointment setter|cold call|cold calling|telemarketing|manual data entry|data entry|copy paste|lead enrichment|enrich leads|customer service|customer support)\b/i.test(text)) {
    return false;
  }

  // Enforce proposal competition: strictly less than 5 proposals
  const propsNum = Number(job.current_proposals_numeric || 0);
  const propsTier = String(job.current_proposals_tier || 'Less than 5').toLowerCase();
  const isUnder5Tier = /^(less than 5|fewer than 5|<5|< 5)$/i.test(propsTier)
    || propsTier.includes('less than 5')
    || propsTier.includes('fewer than 5');
  if (propsNum > 5 || !isUnder5Tier) return false;

  // Enforce solid rate (Hourly >= $30 or Fixed >= $200)
  const isHourly = (job.job_type || '').toLowerCase() === 'hourly';
  if (isHourly) {
    if (job.hourly_max > 0 && job.hourly_max < 30) return false;
  } else {
    if (job.budget > 0 && job.budget < 200) return false;
  }

  return true;
}

function setProposalNotificationHandler(fn) {
  onProposalSubmitted = typeof fn === 'function' ? fn : null;
}

function setProposalFallbackHandler(fn) {
  onProposalFallbackReady = typeof fn === 'function' ? fn : null;
}

async function callUpworkMcpWithRetry(toolName, args, accessToken, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callUpworkMcpTool(toolName, args, accessToken);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      if (attempt < maxAttempts && TRANSIENT_MCP_ERR_RE.test(msg)) {
        console.warn(`[Auto-Proposer] Transient MCP error on ${toolName} (attempt ${attempt}/${maxAttempts}): ${msg}. Retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function getShareHash(jobId) {
  if (String(jobId) === '2122421990107900101') {
    return '7009c82cd76942468c9320b06e1f4ed4';
  }
  return crypto.createHash('md5').update('upwork_loom_' + String(jobId)).digest('hex');
}

function buildUpworkJobUrl(jobId) {
  const id = String(jobId).trim();
  if (id.startsWith('http')) return id;
  if (id.startsWith('~')) return `https://www.upwork.com/jobs/${id}`;
  if (id.startsWith('02') && id.length >= 20) return `https://www.upwork.com/jobs/~${id}`;
  return `https://www.upwork.com/jobs/~02${id}`;
}

function formatUpworkJobRef(jobId) {
  const id = String(jobId || '').trim();
  if (id.startsWith('~')) return id;
  if (id.startsWith('02') && id.length >= 20) return `~${id}`;
  return `~02${id.replace(/^~?02/, '')}`;
}

const CORE_PORTFOLIO_PROJECT_IDS = [
  '2078414807222501376', // AI Voice Agent (Vapi,Retell,Twillio)
  '2070886087321853952', // YouTube Automation Pipeline
  '1968675768626176000'  // AI Resume Assistant
];

const CORE_CERTIFICATE_IDS = [
  '1976429951647964461'  // Machine Learning Specialization
];

function selectPortfolioHighlights() {
  return [...CORE_PORTFOLIO_PROJECT_IDS];
}

function selectCertificateHighlights() {
  return [...CORE_CERTIFICATE_IDS];
}

function isConsultingOrNonBuildJob(job) {
  const title = String(job?.title || '').toLowerCase();
  const desc = String(job?.description || '').toLowerCase();
  const text = `${title}\n${desc}`;

  // Reject if title indicates consulting, coaching, mentoring, or pure audit/review
  if (/\b(consultant|consulting|consultation|advisor|advisory|coach|coaching|mentor|mentoring|mentorship|tutor|tutoring|trainer|training|auditor|code review|architecture review|strategy session|brainstorm|fractional cto|thought partner|teach me|walk me through)\b/i.test(title)
    || (/\baudit\b/i.test(title) && !/\b(build|develop|engineer|development|automation|scraper|platform)\b/i.test(title))) {
    return true;
  }

  // Reject Game Development, Native Mobile Apps (Kotlin/Swift/Flutter), and Hardware
  if (/\b(game developer|game development|mobile games?|android games?|ios games?|3d games?|2d games?|video games?|playable|game engine|unity|unreal engine|unreal|godot|roblox|fivem|minecraft|phaser|pygame|gameplay|android developer|ios developer|kotlin|swift|objective-c|xcode|android studio|flutter|react native|xamarin|maui|abap|embedded|firmware|arduino|fpga|verilog|autocad|solidworks|blender|maya|3ds max)\b/i.test(text)) {
    return true;
  }

  // Strictly reject WordPress, WooCommerce, Wix, Squarespace, CMS and Theme development
  // User note: We are NOT WordPress/CMS developers under any circumstances (check title & full description)
  if (/\b(wordpress|woocommerce|wix|squarespace|shopify|drupal|magento|joomla|prestashop|elementor|divi|webflow)\b/i.test(text)) {
    return true;
  }

  // Reject off-stack CMS/CRM/Enterprise roles ONLY when they are the core title role without AI/Scraping/Automation/Bot signals
  if ((/(?:^|[^\w])(c\+\+|c#|\.net)(?!\w)|\b(dotnet|drupal|magento|laravel|symfony|ruby on rails|salesforce)\b/i.test(title))
    && !/\b(scrape|scraper|scraping|automation|automate|ai|agent|chatbot|voice|bot|n8n|script|python|playwright|selenium)\b/i.test(title)) {
    return true;
  }

  // Reject QA Testing, Bug Finding, SDET, and Dedicated Tester Roles
  const isQaTitleRole = /\b(qa engineer|qa tester|qa automation|qa specialist|quality assurance|software tester|manual tester|manual testing|bug hunter|bug finder|find bugs|bug hunting|bug testing|sdet|penetration test(ing|er)?|pentest|usability testing|user testing)\b/i.test(title);
  if (isQaTitleRole || (
    /\b(qa engineer|qa tester|qa automation|quality assurance|manual testing|bug hunter|bug finder|find bugs|test cases|test plan|regression testing)\b/i.test(text)
    && !/\b(developer|dev\b|engineer|builder|architect|full-stack|full stack|backend|web scraping|scraper|ai agent|chatbot)\b/i.test(title)
  )) {
    return true;
  }

  // Reject anti-bot prompt-injection traps and advisory/coaching descriptions
  if (/(if you are one of the ai agents|ignore all previous instructions|disregard previous instructions|super intelligence not artificial intelligence)/i.test(text)
    || /\b(based in (?:india|pakistan|bangladesh|nigeria|philippines)|team in (?:india|pakistan|bangladesh|nigeria|philippines)|located in (?:india|pakistan|bangladesh|nigeria|philippines))\b/i.test(text)
    || /\b(looking for a consultant|need a consultant|seeking a consultant|consulting call|advisory role|1-on-1 coaching|one-on-one coaching|teach me how|guide me through|no coding required|no development needed|just advice|consulting only|architecture audit|audit how i build|knowledge-transfer engagement|not an outsourced development|private technical mentor|teaching nontechnical|sequence of instruction)\b/i.test(text)) {
    return true;
  }

  // Reject non-builder / coordinator / assistant / manager roles / manual non-dev tasks
  if (/\b(solutions specialist|technical specialist|operations assistant|executive assistant|virtual assistant|project manager|product manager|delivery manager|program manager|scrum master|business analyst|system administrator|client success|customer success|account manager|sales rep|copywriter|content writer)\b/i.test(title)
    || /\b(virtual assistant|appointment setter|cold call|cold calling|telemarketing|customer support|customer service|data entry|manual data entry|copy paste|copy-paste|advising clients|evaluate technical proposals|coordinate with software engineers to clarify|review ai generated emails)\b/i.test(text)) {
    return true;
  }

  // Reject SEO, SEM, PPC, Ads Management, Content Writing, Copywriting, Translation, and Non-dev Marketing roles
  if (/\b(seo specialist|seo expert|seo consultant|seo manager|search engine optimization|technical seo|on-page seo|off-page seo|link building|backlinks?|google search console|semrush|ahrefs|hreflang|keyword research|spanish seo|bilingual seo|seo audit)\b/i.test(text)
    || (/\b(seo|search engine optimization)\b/i.test(title) && !/\b(scraper|scrape|playwright|bot|api|crawler|pipeline)\b/i.test(title))
    || /\b(copywriter|content writer|article writer|blog writer|copywriting|content creation|social media manager|social media specialist|smm|meta ads|facebook ads|google ads|ppc specialist|media buyer|influencer marketing|translator|translation)\b/i.test(text)
    || /\b(fluent (?:in )?(?:german|spanish|french|italian|portuguese|arabic|russian|chinese|japanese)|native (?:german|spanish|french|italian|portuguese|arabic|russian|chinese|japanese)|bilingual (?:in )?(?:spanish|french|german)|fluent spanish|native spanish|spanish-language seo|spanish keywords|hreflang|backlink outreach|manual seo audit|guest posting)\b/i.test(text)) {
    return true;
  }

  // Reject Lead Enrichment, Contact List Building, Email Lists & B2B Lead List jobs
  if (LEAD_ENRICHMENT_RE.test(text)) {
    return true;
  }

  // Require an explicit match in title or opening 280 chars for our 5 core niches:
  // Automation, Chatbot, Voice Agent, Script, Data Scraping
  const leadSummary = `${title}\n${desc.slice(0, 280)}`;
  if (!STRICT_CORE_NICHE_RE.test(leadSummary)) {
    return true;
  }

  // Require a clear hands-on development / engineering / building signal
  const hasBuildSignal = /\b(build|building|develop|developer|development|engineer|engineering|create|implement|automate|automation|automated|workflow|scrape|scraper|scrapers|scraping|extract|extraction|crawl|crawler|crawling|script|scripts|bot|bots|chatbot|chatbots|voice|vapi|retell|twilio|elevenlabs|agent|agents|pipeline|integration|integrate|playwright|selenium|puppeteer|n8n|zapier|make\.com|python|node\.js|nodejs|api)\b/i.test(text);
  return !hasBuildSignal;
}

function isClientHireRateEligible(job) {
  return isClientGeoAndHistoryEligible(job);
}

function isJobEligibleForAutoProposal(job, options = {}) {
  if (!job || !job.job_id) return false;
  if (job.job_status && job.job_status !== 'open') return false;
  if (job.is_ghost_job) return false;
  if (isBlockedClientCountry(job.client_country)) return false;
  if (!options.force && isConsultingOrNonBuildJob(job)) return false;
  if (!options.force && !isClientHireRateEligible(job)) return false;

  // Night shift proposal scheduling: strictly active between 00:00 and 06:00 Turkey time
  // Strictly enforce daily limit (max 5 proposals/day) and 100% exact match
  if (!options.force) {
    if (!isAutoProposalWindowActive()) return false;
    const maxDaily = Number(getSetting('daily_proposal_limit') ?? 5);
    const dailyCount = getDailySubmittedCount();
    if (dailyCount >= maxDaily) return false;
    if (!isTamSametlikJob(job)) return false;
  }

  // Enforce proposals limit: strictly less than 5 proposals per user mandate
  const propsNum = Number(job.current_proposals_numeric || 0);
  const propsTier = String(job.current_proposals_tier || 'Less than 5').toLowerCase();
  const isUnder5Tier = /^(less than 5|fewer than 5|<5|< 5)$/i.test(propsTier)
    || propsTier.includes('less than 5')
    || propsTier.includes('fewer than 5');
  if (propsNum > 5 || !isUnder5Tier) {
    return false;
  }

  // Enforce freshness window (strictly <= 20 minutes for Best Match, <= 10 minutes for general) unless forced manually
  if (!options.force && job.posted_at) {
    const minsSincePosted = (Date.now() - new Date(job.posted_at).getTime()) / 60000;
    const maxMins = (job.keyword_matched === 'Best Match' || job.keyword_matched === 'Most Recent') ? 20 : 10;
    if (minsSincePosted > maxMins) return false;
  }

  const isHourly = (job.job_type || '').toLowerCase() === 'hourly';
  if (isHourly) {
    if (job.hourly_max > 0 && job.hourly_max < 30) return false;
  } else {
    if (job.budget > 0 && job.budget < 150) return false;
  }

  const existingProp = db.prepare('SELECT status FROM auto_proposals WHERE job_id = ?').get(job.job_id);
  if (existingProp && TERMINAL_PROPOSAL_STATUSES.has(existingProp.status)) return false;
  if (!options.force && isInErrorBackoff(job.job_id)) return false;

  return true;
}

function answerScreeningQuestion(question, title, shareUrl) {
  const isProblemJob = /\b(bug|fix|issue|error|fail|failing|broken|debug|block|blocked|captcha|cloudflare|slow|troubleshoot)\b/i.test(String(title || ''));
  const target = isProblemJob ? 'problem' : 'project';
  if (shareUrl) {
    return `Check out the quick 35s Loom I recorded specifically for your ${target}: ${shareUrl}`;
  }
  return `Check out the quick 35s Loom I recorded specifically for your ${target}`;
}

async function ensureVideoGenerated(jobId, strictUnder5 = true) {
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }
  const outPath = path.join(videosDir, `${jobId}.mp4`);
  if (fs.existsSync(outPath)) {
    return { generatedNow: false, outPath };
  }

  if (activeVideoRenders.has(jobId)) {
    return activeVideoRenders.get(jobId);
  }

  const renderPromise = (async () => {
    const upworkUrl = buildUpworkJobUrl(jobId);
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const args = [renderScriptPath, upworkUrl, outPath];
    if (strictUnder5) {
      args.push('--strict-under-5');
    }

    console.log(`[Auto-Proposer] Rendering custom Loom video for ${jobId} -> ${upworkUrl} (strictUnder5=${strictUnder5})`);
    await execFileAsync(pythonCmd, args, {
      maxBuffer: 1024 * 1024 * 20,
      timeout: 150000
    });

    // Automatically publish rendered video + thumbnail + metadata to cloud CDN so Render serves it 24/7 even when PC is off
    try {
      const jobRow = db.prepare('SELECT title, client_country FROM jobs WHERE job_id = ?').get(jobId);
      const upRes = await uploadJobVideoToCloud(jobId, {
        videosDir,
        thumbsDir,
        title: jobRow?.title || '',
        clientCountry: jobRow?.client_country || '',
        shareId: getShareHash(jobId)
      });
      if (upRes?.ok) {
        console.log(`[Cloud-Video] Published ${jobId} (share=${upRes.share_id}) to GitHub CDN for 24/7 Render streaming.`);
      }
    } catch (upErr) {
      console.error(`[Cloud-Video] Upload warning for ${jobId}:`, upErr.message);
    }

    return { generatedNow: true, outPath };
  })();

  activeVideoRenders.set(jobId, renderPromise);
  try {
    return await renderPromise;
  } finally {
    activeVideoRenders.delete(jobId);
  }
}

// Error-retry guard: failed jobs (error_*) are retried at most MAX_ERROR_ATTEMPTS times, spaced by ERROR_RETRY_COOLDOWN_MS,
// and the Telegram fallback alert is sent only ONCE per job (previously every 40s cycle re-sent it => notification spam).
const MAX_ERROR_ATTEMPTS = 2;
const ERROR_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const errorAttempts = new Map();
const fallbackNotifiedJobs = new Set();

function notifyFallbackOnce(payload) {
  const id = payload?.job?.job_id;
  if (!id || fallbackNotifiedJobs.has(id)) return;
  fallbackNotifiedJobs.add(id);
  Promise.resolve(onProposalFallbackReady(payload)).catch(() => {});
}

function isInErrorBackoff(jobId) {
  const a = errorAttempts.get(jobId);
  if (!a) return false;
  return a.count >= MAX_ERROR_ATTEMPTS || (Date.now() - a.last) < ERROR_RETRY_COOLDOWN_MS;
}

function recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, connectsCost, status, previewId = null, details = '') {
  if (String(status).startsWith('error_')) {
    const a = errorAttempts.get(job.job_id) || { count: 0, last: 0 };
    errorAttempts.set(job.job_id, { count: a.count + 1, last: Date.now() });
  }
  db.prepare(`
    INSERT INTO auto_proposals (job_id, job_title, share_id, share_url, charged_amount, connects_cost, status, preview_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      job_title = excluded.job_title,
      share_id = excluded.share_id,
      share_url = excluded.share_url,
      charged_amount = excluded.charged_amount,
      connects_cost = excluded.connects_cost,
      status = excluded.status,
      preview_id = excluded.preview_id,
      details = excluded.details
  `).run(
    job.job_id,
    job.title || 'Upwork Job',
    shareId,
    shareUrl,
    chargedAmount,
    connectsCost || 0,
    status,
    previewId,
    String(details || '').slice(0, 2000)
  );
}

async function submitAutoProposalForJob(job, options = {}) {
  const shareId = getShareHash(job.job_id);
  const shareUrl = `${PUBLIC_BASE_URL}/share/${shareId}`;
  const isHourly = (job.job_type || '').toLowerCase() === 'hourly';
  const chargedAmount = isHourly
    ? Math.min(50, Math.max(30, Number(job.hourly_max) || 45))
    : (Number(job.budget) >= 150 ? Number(job.budget) : 450);

  if (!options.force) {
    const maxDaily = Number(getSetting('daily_proposal_limit') ?? 5);
    const dailyCount = getDailySubmittedCount();
    if (dailyCount >= maxDaily) {
      const reason = `Daily proposal limit reached (${dailyCount}/${maxDaily} submitted today)`;
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_daily_limit_reached', null, reason);
      return { ok: false, status: 'skipped_daily_limit_reached', job_id: job.job_id, reason };
    }
    if (!isTamSametlikJob(job)) {
      const reason = `Job does not qualify for Tam Sametlik criteria (sniper >= 85, tier < 5, core builder stack)`;
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_not_core_sametlik', null, reason);
      return { ok: false, status: 'skipped_not_core_sametlik', job_id: job.job_id, reason };
    }
    if (isConsultingOrNonBuildJob(job)) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_consulting_or_non_dev', null, 'Consulting, coaching, or non-development listing rejected');
      return { ok: false, status: 'skipped_consulting_or_non_dev', job_id: job.job_id };
    }
    const propsNum = Number(job.current_proposals_numeric || 0);
    const propsTier = String(job.current_proposals_tier || 'Less than 5').toLowerCase();
    const isUnder5Tier = /^(less than 5|fewer than 5|<5|< 5)$/i.test(propsTier)
      || propsTier.includes('less than 5')
      || propsTier.includes('fewer than 5');
    if (propsNum > 5 || !isUnder5Tier) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_over_5_proposals', null, `DB tier=${job.current_proposals_tier} (${propsNum})`);
      return { ok: false, status: 'skipped_over_5_proposals', job_id: job.job_id };
    }
    if (job.posted_at) {
      const minsSincePosted = (Date.now() - new Date(job.posted_at).getTime()) / 60000;
      const maxMins = (job.keyword_matched === 'Best Match' || job.keyword_matched === 'Most Recent') ? 20 : 10;
      if (minsSincePosted > maxMins) {
        recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_over_freshness_limit', null, `Posted ${Math.round(minsSincePosted)}m ago (>${maxMins}m freshness limit)`);
        return { ok: false, status: 'skipped_over_freshness_limit', job_id: job.job_id };
      }
    }

    // Direct Upwork MCP mode: skip flconsole getJobDetails unless flconsole_sync_enabled is explicitly true
    let detJob = null;
    if (getSetting('flconsole_sync_enabled') === true) {
      try {
        const { getJobDetails } = require('./flconsole-tracker');
        const detRes = await getJobDetails([job.job_id]);
        detJob = detRes?.jobs?.[0] || null;
        if (detJob) {
          job.description = detJob.description || job.description;
          job.client_country = detJob.client?.country || job.client_country;
          job.client_hire_rate = typeof detJob.client?.hire_rate === 'number' ? detJob.client.hire_rate : job.client_hire_rate;
          job.client_total_spent = detJob.client?.total_spent ?? job.client_total_spent;
          job.client_total_posted = detJob.client?.posted_jobs_count ?? job.client_total_posted;
          job.client_total_hires = detJob.client?.hires_count ?? job.client_total_hires;
          if (detJob.client?.payment_verified !== undefined) {
            job.client_payment_verified = detJob.client.payment_verified ? 1 : 0;
          }
        }
      } catch (detErr) {
        console.warn(`[Auto-Proposer] getJobDetails verification warning for ${job.job_id}: ${detErr.message}`);
      }
    }

    // Verify real client_record (jobs_posted, hire_rate_percent) via rate-limited Upwork MCP action:'get'
    // so incomplete smart_search summaries (e.g. posted=0/1) never slip past the ghost-client filter.
    if (!detJob) {
      try {
        const preToken = await getValidAccessToken();
        if (preToken) {
          const preOrgUid = await getTalentOrgUid(preToken);
          const mcpDet = await callUpworkMcpWithRetry(
            'upwork__find_jobs',
            { action: 'get', org_uid: preOrgUid, params: { job_id: String(job.job_id).replace(/^~?02/, '') } },
            preToken,
            1
          );
          const cr = mcpDet?.client_record;
          const mjp = mcpDet?.data?.marketplaceJobPosting;
          if (cr) {
            job.client_total_posted = cr.jobs_posted ?? job.client_total_posted;
            job.client_total_hires = cr.jobs_with_hires ?? cr.contracts_total ?? job.client_total_hires;
            if (cr.hire_rate_percent !== undefined) {
              job.client_hire_rate = cr.hire_rate_percent;
            } else if (job.client_total_posted > 0) {
              job.client_hire_rate = Math.min(100, Math.round((job.client_total_hires / job.client_total_posted) * 100));
            }
            if (cr.spend_total !== undefined) {
              const parsedSpent = Number(String(cr.spend_total).replace(/[^0-9.]/g, '')) || 0;
              job.client_total_spent = parsedSpent;
            }
            if (cr.payment_verified !== undefined) {
              job.client_payment_verified = cr.payment_verified ? 1 : 0;
            } else if (cr.verification_status !== undefined) {
              job.client_payment_verified = cr.verification_status === 'VERIFIED' ? 1 : 0;
            }
          }
          if (mjp?.content?.description) {
            job.description = String(mjp.content.description).replace(/<\/?untrusted_participant_content>/g, '').trim();
          }
          if (mjp?.clientCompanyPublic?.country?.name) {
            job.client_country = mjp.clientCompanyPublic.country.name;
          }
        }
      } catch (mcpDetErr) {
        console.warn(`[Auto-Proposer] MCP action:get verification warning for ${job.job_id}: ${mcpDetErr.message}`);
      }
    }

    job.sniper_score = calculateSniperScore(job);
    db.prepare(`
      UPDATE jobs
      SET description = ?, client_country = ?, client_hire_rate = ?, client_total_spent = ?, client_total_posted = ?, client_total_hires = ?, client_payment_verified = ?, sniper_score = ?
      WHERE job_id = ?
    `).run(
      job.description,
      job.client_country,
      job.client_hire_rate,
      job.client_total_spent,
      job.client_total_posted,
      job.client_total_hires,
      job.client_payment_verified,
      job.sniper_score,
      job.job_id
    );

    if (isConsultingOrNonBuildJob(job)) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_consulting_or_non_dev', null, 'Full job description matched consulting/mentoring/non-development filter');
      return { ok: false, status: 'skipped_consulting_or_non_dev', job_id: job.job_id };
    }

    if (isBlockedClientCountry(job.client_country) || !isClientHireRateEligible(job)) {
      const reason = `Client blocked or ineligible: country=${job.client_country}, verified=${job.client_payment_verified}, hireRate=${job.client_hire_rate}% (posted=${job.client_total_posted}, hires=${job.client_total_hires})`;
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_low_hire_rate', null, reason);
      return { ok: false, status: 'skipped_low_hire_rate', job_id: job.job_id, reason };
    }

    const avgHourly = Number(detJob?.client?.avg_hourly_rate || 0);
    if (avgHourly > 0 && avgHourly < 15 && Number(detJob?.client?.paid_hours || 0) >= 3) {
      const reason = `Client avg hourly rate paid is $${avgHourly}/hr (< $15/hr minimum)`;
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_low_hire_rate', null, reason);
      return { ok: false, status: 'skipped_low_hire_rate', job_id: job.job_id, reason };
    }

    // AI Semantic Evaluation Layer: LLM reads full posting and judges real match with Sametcan's stack
    console.log(`[Auto-Proposer] Running AI layer evaluation on job ${job.job_id}: ${job.title}...`);
    const aiFit = await evaluateJobFitWithAI(job);
    if (!aiFit.fit) {
      const reason = `AI Screener rejected (${aiFit.confidence}%): ${aiFit.reason}`;
      console.log(`[Auto-Proposer] AI Layer REJECTED job ${job.job_id} (${job.title}): ${reason}`);
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_ai_eval_rejected', null, reason);
      return { ok: false, status: 'skipped_ai_eval_rejected', job_id: job.job_id, reason };
    }
    console.log(`[Auto-Proposer] AI Layer APPROVED job ${job.job_id} (${aiFit.confidence}%): ${aiFit.reason}`);
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'error_no_oauth', null, 'Official Upwork OAuth token missing or expired');
    return { ok: false, status: 'error_no_oauth', job_id: job.job_id };
  }

  let orgUid;
  try {
    orgUid = await getTalentOrgUid(accessToken);
  } catch (orgErr) {
    const msg = String(orgErr?.message || orgErr);
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'error_preview', null, msg);
    return { ok: false, status: 'error_preview', error: msg, job_id: job.job_id };
  }

  // Ensure Upwork disintermediation policy is acknowledged for this session
  try {
    await callUpworkMcpWithRetry(
      'upwork__manage_proposals',
      {
        action: 'acknowledge_policy',
        org_uid: orgUid
      },
      accessToken
    );
  } catch (ackErr) {
    console.warn(`[Auto-Proposer] Policy ack warning: ${ackErr.message}`);
  }

  const numericJobRef = formatUpworkJobRef(job.job_id);
  const coverLetter = buildRyanCoverLetter(job, shareUrl);

  const createParams = {
    job_reference: numericJobRef,
    charged_amount: chargedAmount,
    cover_letter: coverLetter,
    portfolio_project_ids: selectPortfolioHighlights(),
    certificate_ids: selectCertificateHighlights()
  };

  if (!isHourly) {
    createParams.estimated_duration = 'less_than_1_month';
    createParams.payment_mode = 'by_project';
  }

  // Fast pre-flight preview check before spending 35-45s rendering Playwright video
  let previewRes;
  try {
    previewRes = await callUpworkMcpWithRetry(
      'upwork__manage_proposals',
      {
        action: 'create',
        org_uid: orgUid,
        params: createParams
      },
      accessToken
    );
  } catch (createErr) {
    let msg = String(createErr.message || '');
    // "Could not read this job's payment terms": retry once without explicit payment_mode/estimated_duration so Upwork infers terms itself
    if (/payment terms/i.test(msg) && !isHourly) {
      try {
        const relaxed = { ...createParams };
        delete relaxed.payment_mode;
        delete relaxed.estimated_duration;
        previewRes = await callUpworkMcpWithRetry(
          'upwork__manage_proposals',
          { action: 'create', org_uid: orgUid, params: relaxed },
          accessToken
        );
        delete createParams.payment_mode;
        delete createParams.estimated_duration;
        msg = '';
      } catch (retryErr) {
        msg = String(retryErr.message || msg);
      }
    }
    if (msg !== '') {
      if (msg.includes('VJ-JA-10') || msg.toLowerCase().includes('already')) {
        recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_already_applied', null, msg);
        return { ok: false, status: 'skipped_already_applied', job_id: job.job_id };
      }
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'error_preview', null, msg);
      if (onProposalFallbackReady && !options.skipFallbackNotify) {
        notifyFallbackOnce({ job, coverLetter, shareUrl, chargedAmount, connectsCost: 0, error: msg });
      }
      ensureVideoGenerated(job.job_id, false).catch(() => {});
      return { ok: false, status: 'error_preview', error: msg, job_id: job.job_id };
    }
  }

  if (typeof previewRes === 'string' || !previewRes?.preview_id) {
    const errText = typeof previewRes === 'string' ? previewRes : JSON.stringify(previewRes);
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'error_preview', null, errText);
    if (onProposalFallbackReady && !options.skipFallbackNotify) {
      notifyFallbackOnce({ job, coverLetter, shareUrl, chargedAmount, connectsCost: 0, error: errText });
    }
    ensureVideoGenerated(job.job_id, false).catch(() => {});
    return { ok: false, status: 'error_preview', error: errText, job_id: job.job_id };
  }

  const preview = previewRes?.preview || {};
  const baseConnectsCost = Number(preview.connects_cost || 0);
  const rationale = String(preview.boost?.rationale || '').toLowerCase();

  if (preview.can_apply === false || rationale.includes('already hired')) {
    const reason = preview.can_apply === false ? 'can_apply=false' : (preview.boost?.rationale || 'cannot_apply');
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, baseConnectsCost, 'skipped_already_hired', previewRes.preview_id, reason);
    return { ok: false, status: 'skipped_already_hired', job_id: job.job_id, reason };
  }

  // Boosting disabled per user instruction: always submit standard proposal directly (0 boost connects)
  const appliedBoost = 0;
  delete createParams.boost_connects;

  // Handle screening questions if present before confirm
  const rawQuestions = preview.screening_questions || preview.screening_answers || [];
  const hasQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 0;
  if (hasQuestions) {
    createParams.answers = rawQuestions.map(q => {
      const qStr = typeof q === 'string' ? q : (q?.question || String(q));
      const cleanQ = qStr.replace(/<\/?untrusted_participant_content>/gi, '').trim();
      return {
        question: cleanQ,
        answer: answerScreeningQuestion(cleanQ, job.title, shareUrl)
      };
    });

    try {
      previewRes = await callUpworkMcpWithRetry(
        'upwork__manage_proposals',
        {
          action: 'create',
          org_uid: orgUid,
          params: createParams
        },
        accessToken
      );
    } catch (createErr2) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, baseConnectsCost, 'error_screening_answers', null, createErr2.message);
      if (onProposalFallbackReady && !options.skipFallbackNotify) {
        notifyFallbackOnce({ job, coverLetter, shareUrl, chargedAmount, connectsCost: baseConnectsCost, error: createErr2.message });
      }
      ensureVideoGenerated(job.job_id, false).catch(() => {});
      return { ok: false, status: 'error_screening_answers', error: createErr2.message, job_id: job.job_id };
    }
  }

  if (typeof previewRes === 'string' || !previewRes?.preview_id) {
    const errText = typeof previewRes === 'string' ? previewRes : JSON.stringify(previewRes);
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, baseConnectsCost, 'error_preview', null, errText);
    if (onProposalFallbackReady && !options.skipFallbackNotify) {
      notifyFallbackOnce({ job, coverLetter, shareUrl, chargedAmount, connectsCost: baseConnectsCost, error: errText });
    }
    ensureVideoGenerated(job.job_id, false).catch(() => {});
    return { ok: false, status: 'error_preview', error: errText, job_id: job.job_id };
  }

  const connectsCost = baseConnectsCost;

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      job_id: job.job_id,
      share_url: shareUrl,
      charged_amount: chargedAmount,
      connects_cost: connectsCost,
      preview_id: previewRes.preview_id
    };
  }

  const confirmProposalPreview = (previewId) => callUpworkMcpWithRetry(
    'upwork__confirm_preview',
    {
      action: 'confirm',
      org_uid: orgUid,
      params: {
        type: 'proposal',
        preview_id: previewId
      }
    },
    accessToken
  );

  // Confirm & submit IMMEDIATELY (~2s) to secure #1 spot, then render custom video in background
  try {
    let confirmRes;
    try {
      confirmRes = await confirmProposalPreview(previewRes.preview_id);
      if (confirmRes?.status === 'error') {
        throw new Error(confirmRes.reason || JSON.stringify(confirmRes));
      }
    } catch (firstConfirmErr) {
      const errMsg = String(firstConfirmErr?.message || '');
      // Per Upwork MCP guidance: NEVER blindly retry confirm_preview on UNEXPECTED_ERROR (risks cooldown escalation / double connects).
      // Only retry if the preview token genuinely expired.
      const isExpiredPreview = /expir|stale/i.test(errMsg);
      if (!isExpiredPreview) {
        throw firstConfirmErr;
      }
      console.warn(`[Auto-Proposer] Preview ${previewRes.preview_id} expired (${errMsg}); recreating preview...`);
      await new Promise(r => setTimeout(r, 1500));
      previewRes = await callUpworkMcpWithRetry(
        'upwork__manage_proposals',
        {
          action: 'create',
          org_uid: orgUid,
          params: createParams
        },
        accessToken
      );
      if (typeof previewRes === 'string' || !previewRes?.preview_id) {
        throw new Error(typeof previewRes === 'string' ? previewRes : JSON.stringify(previewRes));
      }
      confirmRes = await confirmProposalPreview(previewRes.preview_id);
    }

    const isSuccess = (confirmRes?.status === 'ok' || confirmRes?.status === 'submitted' || confirmRes?.data?.createJobProposal?.status === 'SUCCESS');
    const status = isSuccess ? 'submitted' : 'error_confirm';
    recordAutoProposalOutcome(
      job,
      shareId,
      shareUrl,
      chargedAmount,
      connectsCost,
      status,
      previewRes.preview_id,
      JSON.stringify(confirmRes)
    );

    console.log(`[AUTO-PROPOSAL ${status.toUpperCase()}] Job ${job.job_id} (${job.title}) | $${chargedAmount} | ${connectsCost} Connects (Boost=${appliedBoost}) | ${shareUrl}`);

    if (status === 'submitted') {
      if (onProposalSubmitted) {
        Promise.resolve(onProposalSubmitted({ job, shareUrl, chargedAmount, connectsCost, confirmRes })).catch(() => {});
      }
      ensureVideoGenerated(job.job_id, false)
        .then(r => console.log(`[Auto-Proposer] Background video render completed for ${job.job_id} (generatedNow=${r.generatedNow})`))
        .catch(err => console.error(`[Auto-Proposer] Background video render error for ${job.job_id}:`, err.stderr || err.message));
    } else if (status === 'error_confirm') {
      if (onProposalFallbackReady && !options.skipFallbackNotify) {
        notifyFallbackOnce({ job, coverLetter, shareUrl, chargedAmount, connectsCost, error: confirmRes });
      }
      ensureVideoGenerated(job.job_id, false)
        .then(r => console.log(`[Auto-Proposer] Background fallback video render completed for ${job.job_id}`))
        .catch(() => {});
    }

    return {
      ok: status === 'submitted',
      status,
      job_id: job.job_id,
      job_title: job.title,
      share_url: shareUrl,
      charged_amount: chargedAmount,
      connects_cost: connectsCost,
      preview_id: previewRes.preview_id,
      confirm: confirmRes
    };
  } catch (confirmErr) {
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, connectsCost, 'error_confirm', previewRes?.preview_id, confirmErr.message);
    if (onProposalFallbackReady && !options.skipFallbackNotify) {
      notifyFallbackOnce({ job, coverLetter, shareUrl, chargedAmount, connectsCost, error: confirmErr.message });
    }
    ensureVideoGenerated(job.job_id, false)
      .then(r => console.log(`[Auto-Proposer] Background fallback video render completed for ${job.job_id}`))
      .catch(() => {});
    return { ok: false, status: 'error_confirm', error: confirmErr.message, job_id: job.job_id };
  }
}

async function runAutoProposerCycle(maxPerCycle = 3) {
  if (getSetting('auto_proposer_enabled') === false) {
    return { status: 'disabled', processed: 0 };
  }
  const freezeUntil = Number(getSetting('mcp_freeze_until') || 0);
  if (freezeUntil > Date.now()) {
    return { status: 'frozen_cooldown', processed: 0, freezeUntil };
  }
  if (!isAutoProposalWindowActive()) {
    const curH = getCurrentTurkeyHour();
    return {
      status: 'outside_window',
      processed: 0,
      currentHour: curH,
      message: `Outside auto-proposal window (Active only 00:00 - 06:00 TR time. Current TR hour: ${curH}:00)`
    };
  }
  const maxDaily = Number(getSetting('daily_proposal_limit') ?? 5);
  const dailyCount = getDailySubmittedCount();
  if (dailyCount >= maxDaily) {
    return { status: 'daily_limit_reached', processed: 0, dailyCount, maxDaily };
  }
  if (isProposerRunning) {
    return { status: 'already_running', processed: 0 };
  }

  isProposerRunning = true;
  try {
    const terminalStatusList = Array.from(TERMINAL_PROPOSAL_STATUSES).map(s => `'${s}'`).join(', ');
    const candidates = db.prepare(`
      SELECT * FROM jobs
      WHERE job_status = 'open'
        AND is_ghost_job = 0
        AND client_payment_verified = 1
        AND datetime(posted_at) >= datetime('now', '-30 minutes')
        AND (current_proposals_tier LIKE '%less than 5%' OR current_proposals_tier LIKE '%fewer than 5%' OR current_proposals_numeric <= 5)
        AND job_id NOT IN (
          SELECT job_id FROM auto_proposals
          WHERE status IN (${terminalStatusList})
        )
      ORDER BY posted_at DESC, sniper_score DESC
      LIMIT 10
    `).all();

    const results = [];
    for (const job of candidates) {
      if (results.length >= maxPerCycle) break;
      if (!isJobEligibleForAutoProposal(job)) continue;

      const res = await submitAutoProposalForJob(job);
      results.push(res);
    }

    return {
      status: 'completed',
      processed: results.length,
      results
    };
  } finally {
    isProposerRunning = false;
  }
}

function inferClientDeliverable(job) {
  const title = String(job?.title || '');
  const desc = String(job?.description || '');
  const text = `${title}\n${desc}`.toLowerCase();

  const rules = [
    {
      test: /\b(voice agent|voice ai|vapi|retell|twilio|elevenlabs|pipecat|livekit|phone agent|ai caller|ai receptionist)\b/i,
      deliverable: 'voice agents'
    },
    {
      test: /\b(chatbot|whatsapp bot|telegram bot|discord bot|conversational ai|chat agent)\b/i,
      deliverable: 'chatbots'
    },
    {
      test: /\b(scrape|scraper|scrapers|scraping|web scraping|data scraping|crawl|crawler|crawling|playwright|selenium|puppeteer|browser automation|anti-bot|cloudflare|data extraction|extract data)\b/i,
      deliverable: 'scrapers'
    },
    {
      test: /\b(automation|automate|workflow|\bn8n\b|zapier|make\.com|pipeline|integration|webhook)\b/i,
      deliverable: 'automations'
    },
    {
      test: /\b(ai agent|agentic|\bmcp\b|\brag\b|claude|llm|gpt|assistant)\b/i,
      deliverable: 'AI agents'
    }
  ];

  for (const rule of rules) {
    if (rule.test.test(text)) {
      return rule.deliverable;
    }
  }

  return 'systems';
}

function buildRyanCoverLetter(job, shareUrl) {
  const deliverable = inferClientDeliverable(job);

  return [
    `I've done this exact style of project before, made you a quick Loom:`,
    `${shareUrl}`,
    ``,
    `I've built similar ${deliverable}, so I can help you get this built and running smoothly.`,
    ``,
    `P.S. I've never had a bad review and only five stars on Upwork. So you're in safe hands.`,
    ``,
    `Speak soon,`,
    `Sametcan`
  ].join('\n');
}

module.exports = {
  getShareHash,
  getCurrentTurkeyHour,
  isNightShiftWindow,
  isAutoProposalWindowActive,
  getNightShiftSubmittedCount,
  getDailySubmittedCount,
  isTamSametlikJob,
  inferClientDeliverable,
  buildRyanCoverLetter,
  selectPortfolioHighlights,
  selectCertificateHighlights,
  isConsultingOrNonBuildJob,
  isClientHireRateEligible,
  isJobEligibleForAutoProposal,
  answerScreeningQuestion,
  ensureVideoGenerated,
  submitAutoProposalForJob,
  runAutoProposerCycle,
  setProposalNotificationHandler,
  setProposalFallbackHandler,
  evaluateJobFitWithAI
};
