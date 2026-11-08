const { db, upsertJobAndSnapshot, getSetting, setSetting } = require('./db');
const { getValidAccessToken } = require('./upwork-oauth');

const UPWORK_MCP_URL = process.env.UPWORK_MCP_URL || 'https://mcp.upwork.com/mcp';

let cachedSessionId = null;

async function initMcpSession(accessToken) {
  const res = await fetch(UPWORK_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'upwork-market-intel', version: '1.0.0' }
      }
    })
  });

  if (!res.ok) {
    throw new Error(`MCP init HTTP ${res.status}: ${await res.text()}`);
  }
  cachedSessionId = res.headers.get('mcp-session-id');
  return cachedSessionId;
}

async function callUpworkMcpTool(toolName, args, accessToken, retry = true) {
  if (!cachedSessionId) {
    await initMcpSession(accessToken);
  }

  const res = await fetch(UPWORK_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
      'mcp-session-id': cachedSessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    })
  });

  if (!res.ok && retry) {
    cachedSessionId = null;
    await initMcpSession(accessToken);
    return callUpworkMcpTool(toolName, args, accessToken, false);
  }

  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  const rpc = dataLine ? JSON.parse(dataLine.slice(5)) : JSON.parse(text);

  if (rpc.error) {
    throw new Error(rpc.error.message || JSON.stringify(rpc.error));
  }

  const contentText = rpc?.result?.content?.[0]?.text;
  if (!contentText) return rpc.result;

  const parsed = JSON.parse(contentText);
  if (parsed.status === 'error') {
    throw new Error(`${parsed.error_code}: ${parsed.reason}`);
  }
  return parsed;
}

async function getTalentOrgUid(accessToken) {
  const cachedOrg = getSetting('upwork_org_uid');
  if (cachedOrg) return cachedOrg;

  const accData = await callUpworkMcpTool('upwork__list_accounts', {}, accessToken);
  const accounts = accData.accounts || [];
  const talentAcc = accounts.find(a => a.role === 'TALENT') || accounts[0];
  if (!talentAcc?.org_uid) {
    throw new Error('No Upwork account org_uid found');
  }
  setSetting('upwork_org_uid', talentAcc.org_uid);
  setSetting('upwork_account_name', talentAcc.name);
  return talentAcc.org_uid;
}

function parseMoneyString(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  const cleaned = String(str).replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

function parseBudgetField(budgetStr, jobType) {
  if (!budgetStr) return { budget: 0, hourlyMin: 0, hourlyMax: 0 };
  const s = String(budgetStr);
  if (jobType === 'hourly' || s.includes('/hr')) {
    const parts = s.replace('/hr', '').split(/[–-]/);
    const min = parseMoneyString(parts[0]);
    const max = parseMoneyString(parts[1] || parts[0]);
    return { budget: 0, hourlyMin: min, hourlyMax: max };
  }
  return { budget: parseMoneyString(s), hourlyMin: 0, hourlyMax: 0 };
}

async function fetchLiveJobsForKeyword(keyword, accessToken, orgUid, enrichLimit = 10) {
  const searchRes = await callUpworkMcpTool(
    'upwork__find_jobs',
    {
      action: 'search',
      org_uid: orgUid,
      params: {
        query: keyword,
        sort: 'recency',
        limit: 10,
        include_full_details: false
      }
    },
    accessToken
  );

  const jobs = searchRes.jobs || [];
  const results = [];

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const jobId = String(j.id);
    const existing = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);

    let clientHireRate = existing?.client_hire_rate ?? null;
    let clientTotalPosted = existing?.client_total_posted ?? (j.client?.total_posted_jobs || 1);
    let clientTotalHires = existing?.client_total_hires ?? 0;
    let clientTotalSpent = existing?.client_total_spent ?? parseMoneyString(j.client?.total_spent);

    // Enrich with exact client_record (hire_rate_percent, jobs_with_hires, open_jobs)
    if ((clientHireRate === null || (clientHireRate === 0 && clientTotalSpent > 0)) && i < enrichLimit) {
      try {
        const detail = await callUpworkMcpTool(
          'upwork__find_jobs',
          {
            action: 'get',
            org_uid: orgUid,
            params: { job_id: jobId }
          },
          accessToken
        );
        const cr = detail?.client_record;
        if (cr) {
          clientTotalPosted = cr.jobs_posted ?? clientTotalPosted;
          clientTotalHires = cr.jobs_with_hires ?? cr.contracts_total ?? 0;
          clientHireRate = cr.hire_rate_percent !== undefined
            ? cr.hire_rate_percent
            : (clientTotalPosted > 0 ? Math.min(100, Math.round((clientTotalHires / clientTotalPosted) * 100)) : 0);
          if (cr.spend_total) {
            clientTotalSpent = parseMoneyString(cr.spend_total);
          }
        }
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        // Fallback if rate-limited
      }
    }

    if (clientHireRate === null) {
      // Heuristic fallback if not yet enriched
      const reviews = j.client?.total_reviews || 0;
      clientHireRate = clientTotalPosted > 0
        ? Math.min(100, Math.round((Math.max(reviews, clientTotalSpent > 500 ? 1 : 0) / clientTotalPosted) * 100))
        : 0;
    }

    const { budget, hourlyMin, hourlyMax } = parseBudgetField(j.budget, j.job_type);
    const activity = j.job_activity || {};

    results.push({
      job_id: jobId,
      title: j.title,
      description: (j.description_snippet || j.description || '').replace(/<\/?untrusted_participant_content>/g, '').trim(),
      keyword_matched: keyword,
      job_type: j.job_type === 'hourly' ? 'Hourly' : 'Fixed',
      budget,
      hourly_min: hourlyMin,
      hourly_max: hourlyMax,
      posted_at: j.published_date || j.created_date || new Date().toISOString(),
      checked_at: new Date().toISOString(),
      client_country: j.client?.country || 'United States',
      client_total_spent: clientTotalSpent,
      client_hire_rate: clientHireRate,
      client_total_posted: clientTotalPosted,
      client_total_hires: clientTotalHires,
      client_payment_verified: j.client?.verification_status === 'VERIFIED' ? 1 : 0,
      client_rating: j.client?.rating || 0,
      current_proposals_tier: j.proposals_tier || 'Less than 5',
      interviewing_count: activity.invited_to_interview || 0,
      invites_sent: activity.invites_sent || 0,
      unanswered_invites: Math.max(0, (activity.invites_sent || 0) - (activity.invited_to_interview || 0)),
      hires_count: activity.total_hired || 0
    });
  }

  return results;
}

async function runTrackerCycle(options = {}) {
  const startedAt = new Date().toISOString();
  const activeKeywords = db.prepare('SELECT keyword FROM tracked_keywords WHERE active = 1').all().map(r => r.keyword);
  const accessToken = await getValidAccessToken();

  let newJobsFound = 0;
  let jobsUpdated = 0;
  let mode = accessToken ? 'live_upwork_mcp' : 'lifecycle_poll_simulation';

  try {
    if (accessToken) {
      const orgUid = await getTalentOrgUid(accessToken);
      for (const kw of activeKeywords) {
        const fetched = await fetchLiveJobsForKeyword(kw, accessToken, orgUid, 10);
        for (const job of fetched) {
          const isNew = upsertJobAndSnapshot(job);
          if (isNew) newJobsFound++;
          else jobsUpdated++;
        }
        // Safe pause between keyword searches
        await new Promise(r => setTimeout(r, 800));
      }
    } else if (options.simulateStep) {
      const openJobs = db.prepare(`SELECT * FROM jobs WHERE job_status = 'open' ORDER BY posted_at DESC LIMIT 25`).all();
      const now = new Date();
      for (const job of openJobs) {
        const nextNumeric = job.current_proposals_numeric + Math.floor(Math.random() * 3) + 1;
        let nextTier = 'Less than 5';
        if (nextNumeric >= 50) nextTier = '50+';
        else if (nextNumeric >= 20) nextTier = '20 to 50';
        else if (nextNumeric >= 15) nextTier = '15 to 20';
        else if (nextNumeric >= 10) nextTier = '10 to 15';
        else if (nextNumeric >= 5) nextTier = '5 to 10';

        upsertJobAndSnapshot({
          ...job,
          checked_at: now.toISOString(),
          current_proposals_tier: nextTier,
          current_proposals_numeric: nextNumeric
        });
        jobsUpdated++;
      }
    }

    db.prepare(`
      INSERT INTO bot_runs (run_type, started_at, finished_at, new_jobs_found, jobs_updated, status, details)
      VALUES (?, ?, ?, ?, ?, 'success', ?)
    `).run(
      mode,
      startedAt,
      new Date().toISOString(),
      newJobsFound,
      jobsUpdated,
      `Synced ${activeKeywords.length} keywords (${newJobsFound} new, ${jobsUpdated} updated)`
    );
  } catch (err) {
    db.prepare(`
      INSERT INTO bot_runs (run_type, started_at, finished_at, new_jobs_found, jobs_updated, status, details)
      VALUES (?, ?, ?, ?, ?, 'error', ?)
    `).run(mode, startedAt, new Date().toISOString(), newJobsFound, jobsUpdated, err.message);
  }

  return { mode, newJobsFound, jobsUpdated };
}

module.exports = {
  runTrackerCycle,
  callUpworkMcpTool,
  getTalentOrgUid,
  UPWORK_MCP_URL
};
