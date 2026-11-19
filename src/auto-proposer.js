const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { db, getSetting, calculateSniperScore, LEAD_ENRICHMENT_RE, STRICT_CORE_NICHE_RE, isClientGeoAndHistoryEligible, isBlockedClientCountry } = require('./db');
const { getValidAccessToken } = require('./upwork-oauth');
const { callUpworkMcpTool, getTalentOrgUid } = require('./upwork-tracker');

const execFileAsync = promisify(execFile);

const videosDir = path.join(__dirname, '..', 'public', 'videos');
const renderScriptPath = path.join(__dirname, '..', 'scripts', 'render_video_generator.py');
const PUBLIC_BASE_URL = process.env.PUBLIC_LOOM_URL || 'https://loom.sametcankoksoy.com';

const TERMINAL_PROPOSAL_STATUSES = new Set([
  'submitted',
  'skipped_over_5_proposals',
  'skipped_private_listing',
  'skipped_already_applied',
  'skipped_already_hired',
  'skipped_consulting_or_non_dev',
  'skipped_low_hire_rate',
  'error_screening_answers'
]);

const TRANSIENT_MCP_ERR_RE = /(fetch failed|econnreset|etimedout|socket hang up|\b502\b|\b503\b|\b504\b)/i;

let isProposerRunning = false;
let onProposalSubmitted = null;
const activeVideoRenders = new Map();

function setProposalNotificationHandler(fn) {
  onProposalSubmitted = typeof fn === 'function' ? fn : null;
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

function toNumericJobRef(jobId) {
  return String(jobId).trim().replace(/^~?02/, '');
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

  // Reject off-stack CMS/CRM/Enterprise roles ONLY when they are the core title role without AI/Scraping/Automation/Bot signals
  if ((/(?:^|[^\w])(c\+\+|c#|\.net)(?!\w)|\b(dotnet|wordpress|woocommerce|wix|squarespace|shopify theme|drupal|magento|laravel|symfony|ruby on rails|salesforce)\b/i.test(title))
    && !/\b(scrape|scraper|scraping|automation|automate|ai|agent|chatbot|voice|bot|n8n|script|python|playwright|selenium)\b/i.test(title)) {
    return true;
  }

  // Reject QA Testing, Bug Finding, SDET, and E2E Test Suite Writing jobs
  if (/\b(qa engineer|qa tester|qa automation|qa specialist|quality assurance|software tester|manual testing|bug hunter|bug finder|find bugs|bug hunting|bug testing|bug report|test cases|test plan|regression testing|write unit tests|e2e test(s|ing)?|end-to-end test(s|ing)?|test automation engineer|sdet|penetration test(ing|er)?|pentest|usability testing|user testing)\b/i.test(text)
    && !/\b(web scraping|scraper|data extraction|crawl|crawler)\b/i.test(title)) {
    return true;
  }

  // Reject anti-bot prompt-injection traps and advisory/coaching descriptions
  if (/(if you are one of the ai agents|ignore all previous instructions|disregard previous instructions|super intelligence not artificial intelligence)/i.test(text)
    || /\b(looking for a consultant|need a consultant|seeking a consultant|consulting call|advisory role|1-on-1 coaching|one-on-one coaching|teach me how|guide me through|no coding required|no development needed|just advice|consulting only|architecture audit|audit how i build|knowledge-transfer engagement|not an outsourced development|private technical mentor|teaching nontechnical|sequence of instruction)\b/i.test(text)) {
    return true;
  }

  // Reject non-builder / coordinator / assistant / manager roles
  if (/\b(solutions specialist|technical specialist|operations assistant|executive assistant|virtual assistant|project manager|product manager|delivery manager|program manager|scrum master|business analyst|system administrator|client success|customer success|account manager|sales rep|copywriter|content writer)\b/i.test(title)
    || /\b(advising clients|evaluate technical proposals|coordinate with software engineers to clarify|review ai generated emails)\b/i.test(text)) {
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
  if ((job.sniper_score || 0) < 80) return false;
  if (!options.force && isConsultingOrNonBuildJob(job)) return false;
  if (!options.force && !isClientHireRateEligible(job)) return false;

  // Enforce strict < 5 proposals rule
  const propsNum = Number(job.current_proposals_numeric || 0);
  const propsTier = String(job.current_proposals_tier || 'Less than 5').toLowerCase();
  if (propsNum >= 5 || !['less than 5', 'fewer than 5'].includes(propsTier)) {
    return false;
  }

  // Enforce freshness window (<= 12 minutes since posted) unless forced manually
  if (!options.force && job.posted_at) {
    const minsSincePosted = (Date.now() - new Date(job.posted_at).getTime()) / 60000;
    if (minsSincePosted > 12) return false;
  }

  const isHourly = (job.job_type || '').toLowerCase() === 'hourly';
  if (isHourly) {
    if (job.hourly_max > 0 && job.hourly_max < 30) return false;
  } else {
    if (job.budget > 0 && job.budget < 150) return false;
  }

  const existingProp = db.prepare('SELECT status FROM auto_proposals WHERE job_id = ?').get(job.job_id);
  if (existingProp && TERMINAL_PROPOSAL_STATUSES.has(existingProp.status)) return false;

  return true;
}

function answerScreeningQuestion() {
  return 'check out loom i prepared for you';
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

    return { generatedNow: true, outPath };
  })();

  activeVideoRenders.set(jobId, renderPromise);
  try {
    return await renderPromise;
  } finally {
    activeVideoRenders.delete(jobId);
  }
}

function recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, connectsCost, status, previewId = null, details = '') {
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
    ? Math.min(50, Math.max(35, Number(job.hourly_max) || 45))
    : (Number(job.budget) >= 150 ? Number(job.budget) : 450);

  if (!options.force) {
    if (isConsultingOrNonBuildJob(job)) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_consulting_or_non_dev', null, 'Consulting, coaching, or non-development listing rejected');
      return { ok: false, status: 'skipped_consulting_or_non_dev', job_id: job.job_id };
    }
    const propsNum = Number(job.current_proposals_numeric || 0);
    const propsTier = String(job.current_proposals_tier || 'Less than 5').toLowerCase();
    if (propsNum >= 5 || !['less than 5', 'fewer than 5'].includes(propsTier)) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_over_5_proposals', null, `DB tier=${job.current_proposals_tier} (${propsNum})`);
      return { ok: false, status: 'skipped_over_5_proposals', job_id: job.job_id };
    }
    if (job.posted_at) {
      const minsSincePosted = (Date.now() - new Date(job.posted_at).getTime()) / 60000;
      if (minsSincePosted > 12) {
        recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_over_5_proposals', null, `Posted ${Math.round(minsSincePosted)}m ago (>12m freshness limit)`);
        return { ok: false, status: 'skipped_over_5_proposals', job_id: job.job_id };
      }
    }

    // Verify live client stats & full untruncated description via flconsole get_job_details
    let detJob = null;
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
      }
    } catch (detErr) {
      console.warn(`[Auto-Proposer] getJobDetails verification warning for ${job.job_id}: ${detErr.message}`);
    }

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

  const numericJobRef = toNumericJobRef(job.job_id);
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
    const msg = String(createErr.message || '');
    if (msg.includes('VJ-JA-10') || msg.toLowerCase().includes('already')) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_already_applied', null, msg);
      return { ok: false, status: 'skipped_already_applied', job_id: job.job_id };
    }
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'error_preview', null, msg);
    return { ok: false, status: 'error_preview', error: msg, job_id: job.job_id };
  }

  const preview = previewRes?.preview || {};
  const connectsCost = Number(preview.connects_cost || 0);
  const rationale = String(preview.boost?.rationale || '').toLowerCase();
  const topBids = preview.boost?.current_top_bids || [];

  if (preview.can_apply === false || rationale.includes('already hired')) {
    const reason = preview.can_apply === false ? 'can_apply=false' : preview.boost.rationale;
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, connectsCost, 'skipped_already_hired', previewRes.preview_id, reason);
    return { ok: false, status: 'skipped_already_hired', job_id: job.job_id, reason };
  }

  if (!options.force && topBids.length >= 4) {
    const reason = `Boost slots already full (${topBids.length} top bids: ${JSON.stringify(topBids)}), likely 5+ proposals`;
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, connectsCost, 'skipped_over_5_proposals', previewRes.preview_id, reason);
    return { ok: false, status: 'skipped_over_5_proposals', job_id: job.job_id, reason };
  }

  // Handle screening questions if present before video render
  const rawQuestions = preview.screening_questions || preview.screening_answers || [];
  if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
    createParams.answers = rawQuestions.map(q => {
      const qStr = typeof q === 'string' ? q : (q?.question || String(q));
      const cleanQ = qStr.replace(/<\/?untrusted_participant_content>/gi, '').trim();
      return {
        question: cleanQ,
        answer: answerScreeningQuestion(cleanQ, job.title)
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
    } catch (qErr) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, connectsCost, 'error_screening_answers', null, qErr.message);
      return { ok: false, status: 'error_screening_answers', error: qErr.message, job_id: job.job_id };
    }
  }

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
      if (!/expir|not.?found|invalid.?preview|stale/i.test(String(firstConfirmErr?.message || ''))) {
        throw firstConfirmErr;
      }
      console.warn(`[Auto-Proposer] Preview ${previewRes.preview_id} expired; recreating preview...`);
      previewRes = await callUpworkMcpWithRetry(
        'upwork__manage_proposals',
        {
          action: 'create',
          org_uid: orgUid,
          params: createParams
        },
        accessToken
      );
      confirmRes = await confirmProposalPreview(previewRes.preview_id);
    }

    const status = confirmRes?.status === 'error' ? 'error_confirm' : 'submitted';
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

    console.log(`[AUTO-PROPOSAL ${status.toUpperCase()}] Job ${job.job_id} (${job.title}) | $${chargedAmount} | ${connectsCost} Connects | ${shareUrl}`);

    if (status === 'submitted') {
      if (onProposalSubmitted) {
        Promise.resolve(onProposalSubmitted({ job, shareUrl, chargedAmount, connectsCost, confirmRes })).catch(() => {});
      }
      ensureVideoGenerated(job.job_id, false)
        .then(r => console.log(`[Auto-Proposer] Background video render completed for ${job.job_id} (generatedNow=${r.generatedNow})`))
        .catch(err => console.error(`[Auto-Proposer] Background video render error for ${job.job_id}:`, err.stderr || err.message));
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
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, connectsCost, 'error_confirm', previewRes.preview_id, confirmErr.message);
    return { ok: false, status: 'error_confirm', error: confirmErr.message, job_id: job.job_id };
  }
}

async function runAutoProposerCycle(maxPerCycle = 3) {
  if (getSetting('auto_proposer_enabled') === false) {
    return { status: 'disabled', processed: 0 };
  }
  if (isProposerRunning) {
    return { status: 'already_running', processed: 0 };
  }

  isProposerRunning = true;
  try {
    const candidates = db.prepare(`
      SELECT * FROM jobs
      WHERE job_status = 'open'
        AND is_ghost_job = 0
        AND sniper_score >= 80
        AND datetime(posted_at) >= datetime('now', '-6 hours')
        AND job_id NOT IN (
          SELECT job_id FROM auto_proposals
          WHERE status IN (
            'submitted',
            'skipped_over_5_proposals',
            'skipped_private_listing',
            'skipped_already_applied',
            'skipped_already_hired',
            'skipped_consulting_or_non_dev',
            'skipped_low_hire_rate',
            'error_screening_answers'
          )
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
      deliverable: 'AI voice agents and real-time phone automation systems with Vapi, Retell, Twilio, ElevenLabs, and Python'
    },
    {
      test: /\b(chatbot|whatsapp bot|telegram bot|discord bot|conversational ai|chat agent)\b/i,
      deliverable: 'AI chatbots, WhatsApp/Telegram bots, and automated conversational workflows with Python and Node.js'
    },
    {
      test: /\b(scrape|scraper|scrapers|scraping|web scraping|data scraping|crawl|crawler|crawling|playwright|selenium|puppeteer|browser automation|anti-bot|cloudflare|data extraction|extract data|amazon reviews|product reviews|price tracker)\b/i,
      deliverable: 'resilient web scrapers, data extraction pipelines, and browser automation systems with Playwright, Selenium, and Python'
    },
    {
      test: /(e-commerce|ecommerce|shopify|woocommerce|shopping assistant)/i,
      deliverable: 'AI-powered e-commerce shopping assistants, semantic search pipelines, and custom integrations'
    },
    {
      test: /(recruit|candidate matching|outreach|crm automation|lead gen)/i,
      deliverable: 'AI matching systems, automated outreach workflows, and custom API pipelines'
    },
    {
      test: /(\bmcp\b|\brag\b|evals|clinic|referral|receipt processing|expense management|document automation|pdf extraction)/i,
      deliverable: 'production AI agents with Claude, MCP servers, RAG pipelines, and automated document workflows'
    },
    {
      test: /(business workflow|workflow automation|\bn8n\b|zapier|make\.com)/i,
      deliverable: 'AI workflow automations and custom API integrations with Python and Node.js'
    },
    {
      test: /(dashboard|react|next\.js|saas|platform|full-stack|full stack)/i,
      deliverable: 'production AI agents and full-stack React, Python, and Node.js applications'
    }
  ];

  for (const rule of rules) {
    if (rule.test.test(text)) {
      return rule.deliverable;
    }
  }

  return 'custom AI agents, automation workflows, and full-stack Python and Node.js systems';
}

function buildRyanCoverLetter(job, shareUrl) {
  const deliverable = inferClientDeliverable(job);
  return [
    `☺️ made you a quick loom showing exactly how I'd handle this: ${shareUrl}`,
    ``,
    `I've done this exact style of project before. I've built similar ${deliverable}, so I can help you get this built and running smoothly.`,
    ``,
    `P.S. I've never had a bad review and only five stars on Upwork. So you're in safe hands.`,
    ``,
    `Speak soon,`,
    `Sametcan`
  ].join('\n');
}

module.exports = {
  getShareHash,
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
  setProposalNotificationHandler
};
