const { db, upsertJobAndSnapshot, getSetting, setSetting } = require('./db');

const FLCONSOLE_MCP_URL = process.env.FLCONSOLE_MCP_URL || 'https://mcp.lite.flconsole.com/mcp';

function getFlconsoleToken() {
  return process.env.FLCONSOLE_TOKEN || getSetting('flconsole_token');
}

function setFlconsoleToken(token) {
  setSetting('flconsole_token', String(token).trim());
}

async function callFlconsoleMcp(method, params = {}) {
  const token = getFlconsoleToken();
  if (!token) {
    throw new Error('FLCONSOLE_TOKEN is not set. Get your token by typing /mcp in Telegram @flconsole_upwork_job_alerts_bot');
  }

  const res = await fetch(FLCONSOLE_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: method,
      params: params
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`flconsole MCP error HTTP ${res.status}: ${errorText}`);
  }

  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  const rpc = dataLine ? JSON.parse(dataLine.slice(5)) : JSON.parse(text);

  if (rpc.error) {
    throw new Error(rpc.error.message || JSON.stringify(rpc.error));
  }

  const contentText = rpc?.result?.content?.[0]?.text;
  if (!contentText) return rpc.result;

  try {
    return JSON.parse(contentText);
  } catch {
    return contentText;
  }
}

async function findJobs(query, limit = 30) {
  return callFlconsoleMcp('tools/call', {
    name: 'find_jobs',
    arguments: {
      filters: {
        q: query,
        payment_verified: true
      },
      limit: limit
    }
  });
}

async function getJobDetails(jobId) {
  return callFlconsoleMcp('tools/call', {
    name: 'get_job_details',
    arguments: {
      id: String(jobId)
    }
  });
}

function parseMoney(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

function mapFlconsoleJobToDb(j, keyword) {
  const jobId = String(j.id || j.job_id || (j.url ? j.url.split('~02').pop() : Date.now()));
  const isHourly = (j.job_type || '').toLowerCase().includes('hourly');

  let budget = 0;
  let hourlyMin = 0;
  let hourlyMax = 0;

  if (isHourly) {
    hourlyMin = parseMoney(j.hourly_rate?.min || j.hourly_min || 0);
    hourlyMax = parseMoney(j.hourly_rate?.max || j.hourly_max || hourlyMin);
  } else {
    budget = parseMoney(j.budget || 0);
  }

  const client = j.client || {};
  const clientSpent = parseMoney(client.total_spent || client.spend_total || 0);
  const clientRating = typeof client.rating === 'number' ? client.rating : parseMoney(client.rating || 0);
  const clientVerified = client.payment_verified === false ? 0 : 1;
  const clientCountry = client.country || 'United States';

  const postedAt = j.published_time || j.created_date || j.posted_at || new Date().toISOString();
  const title = j.title || 'Untitled Job';
  const desc = (j.description || j.snippet || '').replace(/<\/?untrusted_participant_content>/g, '').trim();

  return {
    job_id: jobId,
    title: title,
    description: desc,
    keyword_matched: keyword || 'AI & Automation',
    job_type: isHourly ? 'Hourly' : 'Fixed',
    budget: budget,
    hourly_min: hourlyMin,
    hourly_max: hourlyMax,
    posted_at: postedAt,
    checked_at: new Date().toISOString(),
    client_country: clientCountry,
    client_total_spent: clientSpent,
    client_hire_rate: typeof client.hire_rate === 'number' ? client.hire_rate : 75,
    client_total_posted: client.total_posted_jobs || client.jobs_posted || 5,
    client_total_hires: client.total_hires || 3,
    client_payment_verified: clientVerified,
    client_rating: clientRating || 5.0,
    current_proposals_tier: j.proposals_tier || 'Less than 5',
    interviewing_count: 0,
    invites_sent: 0,
    unanswered_invites: 0,
    hires_count: 0
  };
}

async function runFlconsoleSyncCycle() {
  const startedAt = new Date().toISOString();
  const token = getFlconsoleToken();

  if (!token) {
    return {
      status: 'pending_token',
      message: 'flconsole token not configured yet. Send /mcp in Telegram @flconsole_upwork_job_alerts_bot'
    };
  }

  let newJobsFound = 0;
  let jobsUpdated = 0;
  let activeKeywords = db.prepare('SELECT keyword FROM tracked_keywords WHERE active = 1').all().map(r => r.keyword);

  if (activeKeywords.length === 0) {
    activeKeywords = ['Playwright', 'Web Scraping', 'AI Agent', 'Python Automation'];
  }

  try {
    // Single consolidated search query to minimize API calls and capture maximum relevant gigs
    const combinedQuery = activeKeywords.slice(0, 6).map(k => `"${k}"`).join(' OR ');
    const res = await findJobs(combinedQuery, 30);
    const jobs = res?.jobs || (Array.isArray(res) ? res : []);

    for (const rawJob of jobs) {
      const mapped = mapFlconsoleJobToDb(rawJob, activeKeywords[0]);
      const isNew = upsertJobAndSnapshot(mapped);
      if (isNew) newJobsFound++;
      else jobsUpdated++;
    }

    db.prepare(`
      INSERT INTO bot_runs (run_type, started_at, finished_at, new_jobs_found, jobs_updated, status, details)
      VALUES (?, ?, ?, ?, ?, 'success', ?)
    `).run(
      'flconsole_mcp_sync',
      startedAt,
      new Date().toISOString(),
      newJobsFound,
      jobsUpdated,
      `Polled flconsole for [${combinedQuery}] (${newJobsFound} new, ${jobsUpdated} updated)`
    );

    return {
      status: 'success',
      newJobsFound,
      jobsUpdated,
      totalFetched: jobs.length
    };
  } catch (err) {
    db.prepare(`
      INSERT INTO bot_runs (run_type, started_at, finished_at, new_jobs_found, jobs_updated, status, details)
      VALUES (?, ?, ?, ?, ?, 'error', ?)
    `).run('flconsole_mcp_sync', startedAt, new Date().toISOString(), newJobsFound, jobsUpdated, err.message);

    return {
      status: 'error',
      error: err.message
    };
  }
}

module.exports = {
  getFlconsoleToken,
  setFlconsoleToken,
  callFlconsoleMcp,
  findJobs,
  getJobDetails,
  runFlconsoleSyncCycle,
  mapFlconsoleJobToDb,
  FLCONSOLE_MCP_URL
};
