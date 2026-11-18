const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { db, getSetting } = require('./db');
const { getValidAccessToken } = require('./upwork-oauth');
const { callUpworkMcpTool, getTalentOrgUid } = require('./upwork-tracker');

const execFileAsync = promisify(execFile);

const videosDir = path.join(__dirname, '..', 'public', 'videos');
const renderScriptPath = path.join(__dirname, '..', 'scripts', 'render_video_generator.py');
const PUBLIC_BASE_URL = process.env.PUBLIC_LOOM_URL || 'https://loom.sametcankoksoy.com';

let isProposerRunning = false;

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

function isJobEligibleForAutoProposal(job, options = {}) {
  if (!job || !job.job_id) return false;
  if (job.job_status && job.job_status !== 'open') return false;
  if (job.is_ghost_job) return false;
  if ((job.sniper_score || 0) < 80) return false;

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

  const alreadyProcessed = db.prepare('SELECT 1 FROM auto_proposals WHERE job_id = ?').get(job.job_id);
  if (alreadyProcessed) return false;

  return true;
}

function answerScreeningQuestion(questionText, jobTitle = '') {
  const cleanQ = String(questionText || '')
    .replace(/<\/?untrusted_participant_content>/gi, '')
    .trim();
  const qLower = cleanQ.toLowerCase();

  if (/(accuracy|eval|test|measure|verify|reliab|error|retry|audit)/.test(qLower)) {
    return 'I run deterministic schema validation (JSON/Pydantic), automated regression checks on held-out sample batches before release, idempotent job queues so retries never duplicate actions, and structured execution logs with human approval checkpoints.';
  }
  if (/(security|pii|privacy|safe|data|compliance|hipaa|secret|auth)/.test(qLower)) {
    return 'All secrets stay in isolated environment vaults, PII is redacted before any external LLM call unless explicitly authorized under strict zero-retention endpoints, and tools operate on least-privilege OAuth scopes with full audit logging.';
  }
  if (/(milestone|estimate|timeline|cost|hours|phase|deliverable)/.test(qLower)) {
    return 'For Phase 1, I propose an end-to-end working core workflow with logging, validation, and a clean handoff walkthrough in the first 1-2 weeks (~25-35 hours), verified against your real test cases before scaling.';
  }
  if (/(scrap|crawl|playwright|selenium|puppeteer|anti-bot|browser|extract)/.test(qLower)) {
    return 'I build resilient Playwright/Selenium and API reverse-engineering pipelines with session persistence, schema validation, and automated recovery, ranked #7 in Turkey in Data Extraction with 100% Job Success on Upwork.';
  }
  if (/(agent|llm|claude|gpt|rag|mcp|workflow|automation)/.test(qLower)) {
    return `I have shipped multiple production AI agent and automation platforms combining Claude/GPT tool-calling, MCP servers, FastAPI/Node.js workers, and structured validation for projects like "${String(jobTitle).slice(0, 60)}" with a 5.0 rating and 100% JSS on Upwork.`;
  }

  return 'I am a Top Rated Upwork Engineer (100% Job Success Score, 5.0 rating, #7 in Turkey in Data Extraction) specializing in production AI agents, resilient Playwright/Python browser automation, and full-stack Node.js/FastAPI platforms with automated monitoring and recovery.';
}

async function ensureVideoGenerated(jobId, strictUnder5 = true) {
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }
  const outPath = path.join(videosDir, `${jobId}.mp4`);
  if (fs.existsSync(outPath)) {
    return { generatedNow: false, outPath };
  }

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
  }

  const strictUnder5 = options.strictUnder5 !== false && !options.force;
  try {
    await ensureVideoGenerated(job.job_id, strictUnder5);
  } catch (vidErr) {
    const errText = String(vidErr.stderr || vidErr.message || '');
    if (errText.includes('PRIVATE_OR_CLOSED_JOB')) {
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_private_listing', null, 'Job is private or no longer available');
      return { ok: false, status: 'skipped_private_listing', job_id: job.job_id };
    }
    if (errText.includes('PROPOSALS_OVER_5')) {
      const tierMatch = errText.match(/PROPOSALS_OVER_5:([^\r\n]+)/);
      const liveTier = tierMatch ? tierMatch[1].trim() : '20 to 50';
      db.prepare('UPDATE jobs SET current_proposals_tier = ?, current_proposals_numeric = 25 WHERE job_id = ?').run(liveTier, job.job_id);
      recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'skipped_over_5_proposals', null, `Live Upwork page showed: ${liveTier}`);
      return { ok: false, status: 'skipped_over_5_proposals', tier: liveTier, job_id: job.job_id };
    }
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'error_video_render', null, errText);
    return { ok: false, status: 'error_video_render', error: errText, job_id: job.job_id };
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    recordAutoProposalOutcome(job, shareId, shareUrl, chargedAmount, 0, 'error_no_oauth', null, 'Official Upwork OAuth token missing or expired');
    return { ok: false, status: 'error_no_oauth', job_id: job.job_id };
  }

  const orgUid = await getTalentOrgUid(accessToken);
  const numericJobRef = toNumericJobRef(job.job_id);
  const coverLetter = buildRyanCoverLetter(job, shareUrl);

  const createParams = {
    job_reference: numericJobRef,
    charged_amount: chargedAmount,
    cover_letter: coverLetter
  };

  if (!isHourly) {
    createParams.estimated_duration = 'less_than_1_month';
    createParams.payment_mode = 'by_project';
  }

  let previewRes;
  try {
    previewRes = await callUpworkMcpTool(
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

  // Handle screening questions if present
  const rawQuestions = preview.screening_questions || preview.screening_answers || [];
  if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
    const answers = rawQuestions.map(q => {
      const qStr = typeof q === 'string' ? q : (q?.question || String(q));
      const cleanQ = qStr.replace(/<\/?untrusted_participant_content>/gi, '').trim();
      return {
        question: cleanQ,
        answer: answerScreeningQuestion(cleanQ, job.title)
      };
    });

    createParams.answers = answers;
    try {
      previewRes = await callUpworkMcpTool(
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

  // Confirm & officially submit proposal via Upwork MCP
  try {
    const confirmRes = await callUpworkMcpTool(
      'upwork__confirm_preview',
      {
        action: 'confirm',
        org_uid: orgUid,
        params: {
          type: 'proposal',
          preview_id: previewRes.preview_id
        }
      },
      accessToken
    );

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

async function runAutoProposerCycle(maxPerCycle = 1) {
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
        AND job_id NOT IN (SELECT job_id FROM auto_proposals)
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
      test: /\b(scrape|scraper|scraping|crawl|crawler|playwright|selenium|puppeteer|anti-bot|cloudflare|data extraction|amazon reviews|product reviews|price tracker)\b/i,
      deliverable: 'resilient web scrapers and browser automation pipelines with Playwright and Python'
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
    `Hey there, made you a quick loom showing exactly how I'd handle this: ${shareUrl}`,
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
  isJobEligibleForAutoProposal,
  answerScreeningQuestion,
  ensureVideoGenerated,
  submitAutoProposalForJob,
  runAutoProposerCycle
};
