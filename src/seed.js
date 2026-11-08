const { db, upsertJobAndSnapshot } = require('./db');

const SAMPLE_TITLES = {
  'n8n': [
    'Build Automated Lead Qualification & CRM Sync Pipeline in n8n',
    'n8n Expert Needed for Multi-Agent Customer Support Workflow',
    'Migrate 45 Zapier Zaps to Self-Hosted n8n + Supabase',
    'Automated Invoice & Slack Alert System via n8n Webhooks',
    'Urgent: Fix n8n WhatsApp Cloud API + HubSpot Integration'
  ],
  'AI Automation': [
    'End-to-End AI Agency Client Onboarding & Proposal Automation',
    'Claude 3.7 / OpenAI Workflow for Real Estate Document Extraction',
    'Build Autonomous Outbound Sales System (Clay + Instantly + AI)',
    'Custom AI Operations Assistant Integrated with Notion & Gmail',
    'Automate E-commerce Returns & Ticket Triage with AI Agents'
  ],
  'Voice AI': [
    'Vapi / Retell AI Inbound Receptionist for Dental Clinics',
    'Bland AI Outbound Appointment Setter with GoHighLevel Sync',
    'Twilio + ElevenLabs Real-Time Voice Agent Low Latency Setup',
    'AI Cold Calling Qualification System for Solar Leads'
  ],
  'Make.com': [
    'Make.com Scenario Architect for Airtable + Stripe + Xero',
    'Automate Social Media Content Repurposing in Make.com',
    'Fix Complex Make.com Webhook Iterator & Error Handling'
  ],
  'MCP Server': [
    'Develop Custom Model Context Protocol (MCP) Server for Internal ERP',
    'Claude Desktop & Cursor Custom MCP Integration in TypeScript',
    'Build Upwork & CRM Analytics MCP Tooling for Agency Team'
  ],
  'Web Scraping': [
    'High-Volume E-Commerce Price Monitoring Scraper + Proxy Rotation',
    'Automated Directory & LinkedIn Lead Enrichment Pipeline',
    'Real-Time Job Board Aggregator with Anti-Bot Bypass'
  ]
};

const COUNTRIES = ['United States', 'United Kingdom', 'Canada', 'Australia', 'Germany', 'Netherlands', 'UAE'];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function seedHistoricalDataset(count = 160) {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  if (existingCount >= 50) {
    return { seeded: false, count: existingCount };
  }

  const keywords = Object.keys(SAMPLE_TITLES);
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const r1 = seededRandom(i * 13 + 7);
    const r2 = seededRandom(i * 29 + 3);
    const r3 = seededRandom(i * 47 + 11);
    const r4 = seededRandom(i * 61 + 19);

    const kw = keywords[i % keywords.length];
    const titles = SAMPLE_TITLES[kw];
    const baseTitle = titles[i % titles.length];

    // Weight posting hours toward US/EU business hours (13:00 - 21:00 UTC)
    let hourUtc;
    if (r1 < 0.62) {
      hourUtc = 13 + Math.floor(r2 * 9); // 13:00 to 21:00 UTC (16:00 - 00:00 TR)
    } else if (r1 < 0.85) {
      hourUtc = 7 + Math.floor(r2 * 6);  // 07:00 to 12:00 UTC (10:00 - 15:00 TR)
    } else {
      hourUtc = Math.floor(r2 * 7);      // 00:00 to 06:00 UTC
    }

    const daysAgo = Math.floor(r3 * 6); // 0 to 6 days ago
    const postedDate = new Date(now - (daysAgo * 86400000) - ((24 - hourUtc) * 3600000) - Math.floor(r4 * 3500000));
    const ageHours = Math.max(0.2, (now - postedDate.getTime()) / 3600000);

    // Client Hire Rate cohort distribution:
    // ~42% high hire rate (60% - 96%), ~33% medium (35% - 59%), ~25% low (<35%)
    let clientHireRate;
    let clientSpent;
    let paymentVerified = 1;

    if (r2 < 0.42) {
      clientHireRate = 60 + Math.floor(r3 * 37); // 60% - 96%
      clientSpent = 8000 + Math.floor(r4 * 120000);
    } else if (r2 < 0.75) {
      clientHireRate = 35 + Math.floor(r3 * 24); // 35% - 58%
      clientSpent = 1200 + Math.floor(r4 * 18000);
    } else {
      clientHireRate = Math.floor(r3 * 34); // 0% - 33%
      clientSpent = r4 < 0.5 ? 0 : Math.floor(r4 * 900);
      paymentVerified = r4 < 0.35 ? 0 : 1;
    }

    // Budget
    const isFixed = r1 < 0.72;
    const budget = isFixed
      ? (clientHireRate >= 60 ? 1500 + Math.floor(r4 * 6500) : 250 + Math.floor(r4 * 1800))
      : 0;
    const hourlyMin = !isFixed ? (clientHireRate >= 60 ? 45 : 25) : 0;
    const hourlyMax = !isFixed ? (clientHireRate >= 60 ? 95 : 50) : 0;

    // Velocity: how many minutes to hit 5-10 proposals and 10-15 proposals
    // Peak hours (13:00-20:00 UTC) & popular keywords fill much faster and get more total proposals
    const isOffPeakWindow = hourUtc >= 1 && hourUtc <= 10; // 04:00 - 13:00 UTC+3
    const kwSpeedFactor = (kw === 'n8n' || kw === 'AI Automation') ? 0.75 : (kw === 'MCP Server' ? 1.65 : 1.1);
    const hourSpeedFactor = isOffPeakWindow ? 1.85 : 0.85;
    const minsTo5_10 = Math.max(2.5, Math.round((6 + r1 * 28) * kwSpeedFactor * hourSpeedFactor * 10) / 10);
    const minsTo10_15 = Math.round((minsTo5_10 + (isOffPeakWindow ? 18 : 8) + r2 * 35) * 10) / 10;
    const minsTo20Plus = (!isOffPeakWindow && r3 < 0.65) || (isOffPeakWindow && r3 < 0.22)
      ? Math.round((minsTo10_15 + 20 + r4 * 75) * 10) / 10
      : null;

    // Outcome: Hired vs Ghost vs Open
    let hiresCount = 0;
    let interviewingCount = 0;
    let isGhost = 0;
    let status = 'open';
    let minsToInterview = null;
    let minsToHire = null;

    if (ageHours < 3.5) {
      // Newly posted open job
      status = 'open';
      interviewingCount = r1 < 0.3 ? 1 : 0;
    } else if (clientHireRate >= 60) {
      // High hire rate clients (>60%) actually hire ~74% of the time, ghost only ~8%
      if (r4 < 0.74) {
        hiresCount = 1;
        interviewingCount = 2 + Math.floor(r1 * 4);
        status = 'hired';
        minsToInterview = Math.round(18 + r2 * 95);
        minsToHire = Math.round(minsToInterview + 60 + r3 * 480); // 1.5h to 9h
      } else if (r4 < 0.82) {
        isGhost = 1;
        status = 'ghost';
      } else {
        status = 'open';
        interviewingCount = 1 + Math.floor(r2 * 3);
        minsToInterview = Math.round(30 + r1 * 120);
      }
    } else if (clientHireRate >= 35) {
      // Medium hire rate clients hire ~38% of the time, ghost ~36%
      if (r4 < 0.38) {
        hiresCount = 1;
        interviewingCount = 1 + Math.floor(r1 * 3);
        status = 'hired';
        minsToInterview = Math.round(45 + r2 * 180);
        minsToHire = Math.round(minsToInterview + 180 + r3 * 900);
      } else if (r4 < 0.74) {
        isGhost = 1;
        status = 'ghost';
      } else {
        status = 'open';
      }
    } else {
      // Low hire rate clients (<35%) hire only ~11% of the time, ghost ~76%!
      if (r4 < 0.11) {
        hiresCount = 1;
        interviewingCount = 1;
        status = 'hired';
        minsToInterview = Math.round(90 + r2 * 240);
        minsToHire = Math.round(minsToInterview + 300 + r3 * 1400);
      } else if (r4 < 0.87) {
        isGhost = 1;
        status = 'ghost';
      } else {
        status = 'open';
      }
    }

    // Current proposals tier based on age & time-of-day competition density
    let currentTier = isOffPeakWindow ? '5 to 10' : '10 to 15';
    let currentNumeric = isOffPeakWindow ? (6 + Math.floor(r2 * 4)) : (11 + Math.floor(r2 * 6));
    if (ageHours < 0.3) {
      currentTier = 'Less than 5';
      currentNumeric = 3;
    } else if (ageHours < 0.8 || (isOffPeakWindow && r1 < 0.65)) {
      currentTier = '5 to 10';
      currentNumeric = 7 + Math.floor(r3 * 3);
    } else if (minsTo20Plus && ageHours > 2) {
      currentTier = r1 < 0.3 ? '50+' : '20 to 50';
      currentNumeric = r1 < 0.3 ? 55 : 28;
    }

    const jobId = `~01upw${String(100000 + i)}${kw.slice(0, 2).toLowerCase()}`;

    upsertJobAndSnapshot({
      job_id: jobId,
      title: `${baseTitle} (#${i + 1})`,
      description: `Looking for a specialist in ${kw} to architect and deploy a production system. Budget is flexible for proven experts.`,
      keyword_matched: kw,
      job_type: isFixed ? 'Fixed' : 'Hourly',
      budget,
      hourly_min: hourlyMin,
      hourly_max: hourlyMax,
      posted_at: postedDate.toISOString(),
      checked_at: new Date().toISOString(),
      client_country: COUNTRIES[i % COUNTRIES.length],
      client_total_spent: clientSpent,
      client_hire_rate: clientHireRate,
      client_total_posted: Math.max(2, Math.floor(clientSpent / 1500) + 2),
      client_total_hires: Math.max(1, Math.floor(((Math.floor(clientSpent / 1500) + 2) * clientHireRate) / 100)),
      client_payment_verified: paymentVerified,
      client_rating: (4.4 + (r1 * 0.6)).toFixed(2),
      current_proposals_tier: currentTier,
      current_proposals_numeric: currentNumeric,
      interviewing_count: interviewingCount,
      invites_sent: clientHireRate >= 60 ? Math.floor(r2 * 4) : 0,
      unanswered_invites: Math.floor(r3 * 2),
      hires_count: hiresCount,
      job_status: status,
      is_ghost_job: isGhost,
      mins_to_5_10_proposals: ageHours < 0.25 ? null : minsTo5_10,
      mins_to_10_15_proposals: ageHours < 0.7 ? null : minsTo10_15,
      mins_to_20_plus_proposals: minsTo20Plus,
      mins_to_first_interview: minsToInterview,
      mins_to_hire: minsToHire
    });
  }

  // Also add 4 fresh "Sniper" open jobs posted in the last 8 minutes (<5 proposals, >75% client hire rate)
  const sniperSeeds = [
    {
      job_id: '~01sniper_live_01',
      title: 'Enterprise n8n + Claude MCP Workflow Architect ($4,500 Fixed)',
      keyword_matched: 'n8n',
      job_type: 'Fixed',
      budget: 4500,
      posted_at: new Date(now - 4 * 60000).toISOString(),
      client_country: 'United States',
      client_total_spent: 84500,
      client_hire_rate: 88,
      current_proposals_tier: 'Less than 5',
      current_proposals_numeric: 2,
      interviewing_count: 0,
      hires_count: 0,
      job_status: 'open',
      is_ghost_job: 0,
      mins_to_5_10_proposals: null
    },
    {
      job_id: '~01sniper_live_02',
      title: 'Build Custom Upwork & HubSpot AI Automation Pipeline',
      keyword_matched: 'AI Automation',
      job_type: 'Fixed',
      budget: 3200,
      posted_at: new Date(now - 9 * 60000).toISOString(),
      client_country: 'United Kingdom',
      client_total_spent: 42000,
      client_hire_rate: 79,
      current_proposals_tier: '5 to 10',
      current_proposals_numeric: 6,
      interviewing_count: 1,
      hires_count: 0,
      job_status: 'open',
      is_ghost_job: 0,
      mins_to_5_10_proposals: 7.5
    },
    {
      job_id: '~01sniper_live_03',
      title: 'Custom MCP Server Development for Internal Postgres & Slack',
      keyword_matched: 'MCP Server',
      job_type: 'Hourly',
      budget: 0,
      hourly_min: 65,
      hourly_max: 110,
      posted_at: new Date(now - 6 * 60000).toISOString(),
      client_country: 'United States',
      client_total_spent: 115000,
      client_hire_rate: 92,
      current_proposals_tier: 'Less than 5',
      current_proposals_numeric: 3,
      interviewing_count: 0,
      hires_count: 0,
      job_status: 'open',
      is_ghost_job: 0,
      mins_to_5_10_proposals: null
    }
  ];

  for (const s of sniperSeeds) {
    upsertJobAndSnapshot(s);
  }

  return { seeded: true, count: count + sniperSeeds.length };
}

if (require.main === module) {
  const res = seedHistoricalDataset();
  console.log('Seed result:', res);
}

module.exports = { seedHistoricalDataset };
