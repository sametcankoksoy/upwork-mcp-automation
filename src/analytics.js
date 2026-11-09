const { db } = require('./db');

function getFullMarketAnalytics(keywordFilter = null) {
  let whereClause = '';
  if (keywordFilter && keywordFilter !== 'ALL') {
    if (keywordFilter.startsWith('GROUP:')) {
      const grp = keywordFilter.slice(6).replace(/'/g, "''");
      whereClause = `WHERE keyword_matched IN (SELECT keyword FROM tracked_keywords WHERE category = '${grp}')`;
    } else {
      const kw = keywordFilter.replace(/'/g, "''");
      whereClause = `WHERE keyword_matched = '${kw}'`;
    }
  }

  // 1. High-level KPI Summary
  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_jobs,
      SUM(CASE WHEN datetime(posted_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as jobs_last_24h,
      SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1 ELSE 0 END) as total_hired_jobs,
      SUM(CASE WHEN is_ghost_job = 1 OR job_status = 'ghost' THEN 1 ELSE 0 END) as total_ghost_jobs,
      SUM(CASE WHEN job_status = 'open' AND is_ghost_job = 0 THEN 1 ELSE 0 END) as total_active_open,
      ROUND(AVG(mins_to_5_10_proposals), 1) as avg_mins_to_5_10,
      ROUND(AVG(mins_to_10_15_proposals), 1) as avg_mins_to_10_15,
      ROUND(AVG(mins_to_20_plus_proposals), 1) as avg_mins_to_20_plus,
      ROUND(AVG(mins_to_first_interview), 1) as avg_mins_to_interview,
      ROUND(AVG(mins_to_hire) / 60.0, 1) as avg_hours_to_hire,
      ROUND(AVG(CASE WHEN budget > 0 THEN budget ELSE NULL END), 0) as avg_fixed_budget,
      ROUND(AVG(client_hire_rate), 1) as avg_client_hire_rate
    FROM jobs
    ${whereClause}
  `).get();

  const total = summary.total_jobs || 1;
  summary.hire_conversion_rate = Math.round(((summary.total_hired_jobs || 0) / total) * 1000) / 10;
  summary.ghost_job_rate = Math.round(((summary.total_ghost_jobs || 0) / total) * 1000) / 10;

  // 2. Budget Tier Distribution ($0–100, $100–500, $500–1K, $1K–5K, $5K+)
  const budgetTiers = db.prepare(`
    SELECT
      CASE
        WHEN budget > 0 AND budget <= 100 THEN '$0 – $100 (Micro)'
        WHEN budget > 100 AND budget <= 500 THEN '$100 – $500 (Small)'
        WHEN budget > 500 AND budget <= 1000 THEN '$500 – $1,000 (Medium)'
        WHEN budget > 1000 AND budget <= 5000 THEN '$1,000 – $5,000 (High Value)'
        WHEN budget > 5000 THEN '$5,000+ (Enterprise / Whale)'
        WHEN hourly_max > 0 AND hourly_max <= 25 THEN 'Hourly: Under $25/hr'
        WHEN hourly_max > 25 AND hourly_max <= 50 THEN 'Hourly: $25 – $50/hr'
        ELSE 'Hourly: $50+/hr (Premium)'
      END as tier_label,
      COUNT(*) as job_count,
      ROUND(AVG(current_proposals_numeric), 1) as avg_proposals,
      ROUND(SUM(CASE WHEN current_proposals_numeric <= 10 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as low_comp_pct,
      ROUND(SUM(CASE WHEN client_hire_rate >= 60 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as high_hire_client_pct,
      ROUND(SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as hire_rate_pct
    FROM jobs
    ${whereClause}
    GROUP BY tier_label
    ORDER BY MIN(CASE WHEN budget > 0 THEN budget ELSE hourly_max * 40 END) ASC
  `).all();

  // 2b. Proposal Competition Buckets (<5, 5–10, 10–20, 20+)
  const proposalBuckets = db.prepare(`
    SELECT
      CASE
        WHEN current_proposals_numeric < 5 THEN '< 5 Proposals (Fresh / Uncontested)'
        WHEN current_proposals_numeric <= 10 THEN '5 – 10 Proposals (Active Window)'
        WHEN current_proposals_numeric <= 20 THEN '10 – 20 Proposals (Competitive)'
        ELSE '20+ Proposals (Heavily Saturated)'
      END as proposal_tier,
      COUNT(*) as job_count,
      ROUND(SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as actual_hire_rate_pct,
      ROUND(AVG(client_hire_rate), 1) as avg_client_hire_rate,
      ROUND(AVG(CASE WHEN budget > 0 THEN budget ELSE NULL END), 0) as avg_budget
    FROM jobs
    ${whereClause}
    GROUP BY proposal_tier
    ORDER BY MIN(current_proposals_numeric) ASC
  `).all();

  // 2c. Bütçe Dilimlerine Göre Teklif Doygunluğu Matrisi (Budget Tier vs Proposal Saturation)
  const budgetVsSaturation = db.prepare(`
    SELECT
      CASE
        WHEN job_type = 'Hourly' AND hourly_max >= 50 THEN 'Saatlik: $50+/sa'
        WHEN job_type = 'Hourly' AND hourly_max >= 25 THEN 'Saatlik: $25–$50/sa'
        WHEN job_type = 'Hourly' THEN 'Saatlik: <$25/sa'
        WHEN budget >= 5000 THEN 'Sabit: $5K+'
        WHEN budget >= 1000 THEN 'Sabit: $1K–$5K'
        WHEN budget >= 500 THEN 'Sabit: $500–$1K'
        WHEN budget >= 100 THEN 'Sabit: $100–$500'
        ELSE 'Sabit: $0–$100'
      END as tier_label,
      COUNT(*) as total_jobs,
      ROUND(AVG(current_proposals_numeric), 1) as avg_proposals,
      ROUND(SUM(CASE WHEN current_proposals_numeric < 5 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as under_5_pct,
      ROUND(SUM(CASE WHEN current_proposals_numeric >= 5 AND current_proposals_numeric <= 10 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as between_5_10_pct,
      ROUND(SUM(CASE WHEN current_proposals_numeric > 10 AND current_proposals_numeric <= 20 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as between_10_20_pct,
      ROUND(SUM(CASE WHEN current_proposals_numeric > 20 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as over_20_pct,
      ROUND(SUM(CASE WHEN current_proposals_numeric <= 10 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as low_comp_pct,
      ROUND(AVG(client_hire_rate), 1) as avg_client_hire_rate,
      ROUND(AVG(client_total_spent), 0) as avg_client_spend
    FROM jobs
    ${whereClause}
    GROUP BY tier_label
    ORDER BY MIN(CASE WHEN budget > 0 THEN budget ELSE hourly_max * 40 END) ASC
  `).all();

  // 2d. Müşteri Kalite Karnesi (Whales vs Medium vs Ghost/Riskli Müşteriler)
  const hireRateCohorts = db.prepare(`
    SELECT
      CASE
        WHEN client_hire_rate >= 60 THEN '60%+ High Hire Rate (Whales)'
        WHEN client_hire_rate >= 35 THEN '35% - 59% Medium Hire Rate'
        ELSE 'Under 35% Low Hire Rate'
      END as cohort,
      COUNT(*) as jobs_posted,
      ROUND(AVG(client_hire_rate), 1) as avg_client_hire_rate,
      ROUND(AVG(client_total_spent), 0) as avg_client_spend,
      ROUND(AVG(client_total_posted), 1) as avg_jobs_posted,
      ROUND(AVG(client_total_hires), 1) as avg_hires_made,
      ROUND(AVG(client_rating), 2) as avg_rating,
      ROUND(SUM(CASE WHEN client_payment_verified = 1 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as payment_verified_pct,
      ROUND(AVG(current_proposals_numeric), 1) as avg_proposals,
      ROUND(SUM(CASE WHEN interviewing_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as interviewing_rate_pct,
      SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1 ELSE 0 END) as jobs_hired,
      ROUND(SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as actual_hire_conversion_pct,
      SUM(CASE WHEN is_ghost_job = 1 OR job_status = 'ghost' THEN 1 ELSE 0 END) as ghost_jobs,
      ROUND(SUM(CASE WHEN is_ghost_job = 1 OR job_status = 'ghost' THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as ghost_rate_pct,
      ROUND(AVG(CASE WHEN budget > 0 THEN budget ELSE NULL END), 0) as avg_budget,
      ROUND(AVG(mins_to_5_10_proposals), 1) as avg_mins_to_5_10_apply,
      ROUND(AVG(mins_to_hire) / 60.0, 1) as avg_hours_to_hire
    FROM jobs
    ${whereClause}
    GROUP BY cohort
    ORDER BY MIN(client_hire_rate) DESC
  `).all();

  // 3. Hourly Posting Volume, Competition Density & Saturation Speed (24 Hours UTC & TRT UTC+3)
  const rawHourly = db.prepare(`
    SELECT
      posted_hour_utc,
      COUNT(*) as jobs_count,
      ROUND(AVG(current_proposals_numeric), 1) as avg_total_proposals,
      SUM(CASE WHEN current_proposals_numeric <= 10 THEN 1 ELSE 0 END) as low_competition_jobs,
      ROUND(SUM(CASE WHEN current_proposals_numeric <= 10 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as low_competition_pct,
      ROUND(AVG(mins_to_5_10_proposals), 1) as avg_mins_to_5_10,
      ROUND(AVG(mins_to_10_15_proposals), 1) as avg_mins_to_10_15,
      ROUND(AVG(CASE WHEN budget > 0 THEN budget ELSE NULL END), 0) as avg_budget,
      ROUND(SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as hire_rate_pct,
      ROUND(SUM(CASE WHEN is_ghost_job = 1 OR job_status = 'ghost' THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as ghost_rate_pct
    FROM jobs
    ${whereClause}
    GROUP BY posted_hour_utc
    ORDER BY posted_hour_utc ASC
  `).all();

  const hourlyMap = new Map(rawHourly.map(r => [r.posted_hour_utc, r]));
  const hourlyDistribution = [];
  for (let h = 0; h < 24; h++) {
    const row = hourlyMap.get(h) || {
      posted_hour_utc: h,
      jobs_count: 0,
      avg_total_proposals: 0,
      low_competition_jobs: 0,
      low_competition_pct: 0,
      avg_mins_to_5_10: null,
      avg_mins_to_10_15: null,
      avg_budget: 0,
      hire_rate_pct: 0,
      ghost_rate_pct: 0
    };
    const trtHour = (h + 3) % 24;
    // Calculate Golden Hour Opportunity Index: High job volume paired with low proposal pressure
    let verdict = 'Quiet Hour (Low Volume)';
    let isGoldenHour = false;
    if (row.jobs_count >= 2 && row.avg_total_proposals <= 12) {
      verdict = '🔥 Golden Hour (High Volume, Low Proposals)';
      isGoldenHour = true;
    } else if (row.jobs_count > 0 && row.avg_total_proposals <= 10) {
      verdict = '🟢 Favorable (Low Proposals)';
      isGoldenHour = true;
    } else if (row.jobs_count >= 3 && row.avg_total_proposals > 20) {
      verdict = '⚠️ Crowded (High Jobs, Saturated Proposals)';
    } else if (row.jobs_count > 0) {
      verdict = '🟡 Moderate';
    }

    const opportunityScore = row.jobs_count > 0
      ? Math.round(
          (Math.min(10, row.jobs_count) * 4) +
          (Math.max(0, 35 - row.avg_total_proposals) * 1.5) +
          (row.low_competition_pct * 0.2)
        )
      : 0;

    hourlyDistribution.push({
      ...row,
      is_golden_hour: isGoldenHour,
      opportunity_verdict: verdict,
      opportunity_score: Math.min(100, Math.max(0, opportunityScore)),
      hour_label_utc: `${String(h).padStart(2, '0')}:00 UTC`,
      hour_label_trt: `${String(trtHour).padStart(2, '0')}:00 UTC+3`,
      window_label_utc: `${String(h).padStart(2, '0')}:00 - ${String((h + 1) % 24).padStart(2, '0')}:00 UTC`,
      window_label_trt: `${String(trtHour).padStart(2, '0')}:00 - ${String((trtHour + 1) % 24).padStart(2, '0')}:00 (TR)`
    });
  }

  // 3b. Best Low-Competition Time Windows (3-Hour Blocks & Golden Hours Ranking)
  const timeBlockWindows = [];
  for (let startUtc = 0; startUtc < 24; startUtc += 3) {
    const blockHours = [startUtc, (startUtc + 1) % 24, (startUtc + 2) % 24];
    const slice = hourlyDistribution.filter(h => blockHours.includes(h.posted_hour_utc));
    const totalJobs = slice.reduce((a, b) => a + b.jobs_count, 0);
    const weightedProps = totalJobs > 0
      ? Math.round((slice.reduce((a, b) => a + (b.avg_total_proposals * b.jobs_count), 0) / totalJobs) * 10) / 10
      : 0;
    const valid5_10 = slice.filter(b => b.avg_mins_to_5_10 !== null && b.jobs_count > 0);
    const valid5_10Jobs = valid5_10.reduce((a, b) => a + b.jobs_count, 0);
    const weighted5_10 = valid5_10Jobs > 0
      ? Math.round((valid5_10.reduce((a, b) => a + (b.avg_mins_to_5_10 * b.jobs_count), 0) / valid5_10Jobs) * 10) / 10
      : null;
    const weightedHire = totalJobs > 0
      ? Math.round((slice.reduce((a, b) => a + (b.hire_rate_pct * b.jobs_count), 0) / totalJobs) * 10) / 10
      : 0;
    const lowCompCount = slice.reduce((a, b) => a + (b.low_competition_jobs || 0), 0);
    const lowCompPct = totalJobs > 0 ? Math.round((lowCompCount / totalJobs) * 1000) / 10 : 0;

    const startTrt = (startUtc + 3) % 24;
    const endTrt = (startTrt + 3) % 24;

    let compLevel = 'No Data Yet';
    if (totalJobs > 0) {
      if (weightedProps <= 12) compLevel = 'Low Competition (Golden Window)';
      else if (weightedProps <= 22) compLevel = 'Moderate Competition';
      else compLevel = 'High Competition (Crowded)';
    }

    timeBlockWindows.push({
      block_utc: `${String(startUtc).padStart(2, '0')}:00 - ${String((startUtc + 3) % 24).padStart(2, '0')}:00 UTC`,
      block_trt: `${String(startTrt).padStart(2, '0')}:00 - ${String(endTrt).padStart(2, '0')}:00 (UTC+3)`,
      total_jobs: totalJobs,
      avg_proposals_per_job: totalJobs > 0 ? weightedProps : null,
      avg_mins_to_5_10: totalJobs > 0 ? weighted5_10 : null,
      low_competition_pct: lowCompPct,
      hire_rate_pct: weightedHire,
      competition_level: compLevel
    });
  }
  // Sort blocks with actual jobs first (by lowest proposals), and put 0-job blocks at the bottom
  timeBlockWindows.sort((a, b) => {
    if (a.total_jobs === 0 && b.total_jobs === 0) return 0;
    if (a.total_jobs === 0) return 1;
    if (b.total_jobs === 0) return -1;
    return a.avg_proposals_per_job - b.avg_proposals_per_job;
  });

  // 4. Keyword / Niche Breakdown (Job Volume, Velocity, Avg Applies, Ghost Rate, Hire Rate)
  const keywordBreakdown = db.prepare(`
    SELECT
      j.keyword_matched as keyword,
      COALESCE(tk.category, 'Other') as category_group,
      COUNT(*) as total_jobs,
      SUM(CASE WHEN datetime(j.posted_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as jobs_last_24h,
      ROUND(AVG(j.current_proposals_numeric), 1) as avg_proposals,
      SUM(CASE WHEN j.current_proposals_numeric <= 10 THEN 1 ELSE 0 END) as low_apply_jobs,
      ROUND(SUM(CASE WHEN j.current_proposals_numeric <= 10 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as low_apply_pct,
      ROUND(AVG(j.mins_to_5_10_proposals), 1) as avg_mins_to_5_10,
      ROUND(AVG(j.mins_to_10_15_proposals), 1) as avg_mins_to_10_15,
      ROUND(SUM(CASE WHEN j.job_status = 'hired' OR j.hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as hire_conversion_pct,
      ROUND(SUM(CASE WHEN j.is_ghost_job = 1 OR j.job_status = 'ghost' THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as ghost_rate_pct,
      ROUND(SUM(CASE WHEN j.client_hire_rate >= 60 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as high_hire_client_pct,
      ROUND(AVG(CASE WHEN j.budget > 0 THEN j.budget ELSE NULL END), 0) as avg_budget,
      ROUND(AVG(CASE WHEN j.hourly_max > 0 THEN j.hourly_max ELSE NULL END), 0) as avg_hourly_rate
    FROM jobs j
    LEFT JOIN tracked_keywords tk ON tk.keyword = j.keyword_matched
    GROUP BY j.keyword_matched
    ORDER BY avg_proposals ASC, total_jobs DESC
  `).all();

  // 4b. Macro Group Breakdown (Development, AI & Data, Automation, Marketing, Design)
  const groupBreakdown = db.prepare(`
    SELECT
      COALESCE(tk.category, 'Other') as group_name,
      COUNT(*) as total_jobs,
      SUM(CASE WHEN datetime(j.posted_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as jobs_last_24h,
      ROUND(AVG(j.current_proposals_numeric), 1) as avg_proposals,
      ROUND(SUM(j.current_proposals_numeric) * 1.0 / COUNT(*), 1) as apply_to_job_ratio,
      ROUND(SUM(CASE WHEN j.current_proposals_numeric <= 10 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as low_apply_pct,
      ROUND(AVG(j.mins_to_5_10_proposals), 1) as avg_mins_to_5_10,
      ROUND(SUM(CASE WHEN j.client_hire_rate >= 60 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as high_hire_client_pct,
      ROUND(SUM(CASE WHEN j.job_status = 'hired' OR j.hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as hire_conversion_pct,
      ROUND(AVG(CASE WHEN j.budget > 0 THEN j.budget ELSE NULL END), 0) as avg_budget,
      ROUND(AVG(CASE WHEN j.hourly_max > 0 THEN j.hourly_max ELSE NULL END), 0) as avg_hourly_rate
    FROM jobs j
    LEFT JOIN tracked_keywords tk ON tk.keyword = j.keyword_matched
    GROUP BY group_name
    ORDER BY avg_proposals ASC
  `).all();

  // 5. Proposal Velocity Distribution (How fast jobs hit 5-10 proposals)
  const velocityBuckets = db.prepare(`
    SELECT
      CASE
        WHEN mins_to_5_10_proposals IS NULL THEN 'Still < 5 Proposals'
        WHEN mins_to_5_10_proposals <= 5 THEN '0 - 5 mins (Ultra Fast)'
        WHEN mins_to_5_10_proposals <= 15 THEN '5 - 15 mins (Fast)'
        WHEN mins_to_5_10_proposals <= 30 THEN '15 - 30 mins (Moderate)'
        WHEN mins_to_5_10_proposals <= 60 THEN '30 - 60 mins (Slow)'
        ELSE '60+ mins (Low Competition)'
      END as speed_bucket,
      COUNT(*) as job_count,
      ROUND(SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as hire_rate_pct
    FROM jobs
    ${whereClause}
    GROUP BY speed_bucket
  `).all();

  // 5c. Technology & Skill Trends Extraction (Aligned with Sametcan's Stack)
  const trackedTechList = [
    { name: 'Python Automation', regex: /(python|script)/i },
    { name: 'AI Agents & LLM', regex: /(agent|claude|gpt|llm|openai|deepseek|langchain|llamaindex)/i },
    { name: 'Playwright & Selenium', regex: /(playwright|selenium|puppeteer|browser automation)/i },
    { name: 'Website Scraping', regex: /(scrap|crawl|anti-bot|cloudflare|stealth)/i },
    { name: 'Node.js & Backend', regex: /(node|express|fastapi|django|postgres|supabase|backend|api)/i },
    { name: 'Full-Stack Development', regex: /(full-stack|full stack|react|next\.js|typescript)/i },
    { name: 'Workflow Automation', regex: /(automation|workflow|n8n|make\.com)/i }
  ];

  const allJobsForTech = db.prepare(`SELECT * FROM jobs ${whereClause}`).all();
  const techTrends = trackedTechList.map(tech => {
    const matched = allJobsForTech.filter(j => tech.regex.test(j.title || '') || tech.regex.test(j.description || ''));
    const totalJobs = matched.length;
    if (totalJobs === 0) return null;

    const jobs24h = matched.filter(j => {
      const diff = (Date.now() - new Date(j.posted_at).getTime()) / 3600000;
      return diff <= 24;
    }).length;

    const avgProps = Math.round((matched.reduce((a, b) => a + (b.current_proposals_numeric || 0), 0) / totalJobs) * 10) / 10;
    const lowComp = Math.round((matched.filter(j => (j.current_proposals_numeric || 0) <= 10).length / totalJobs) * 100);
    const highHire = Math.round((matched.filter(j => (j.client_hire_rate || 0) >= 60).length / totalJobs) * 100);

    const budgets = matched.filter(j => j.budget > 0).map(j => j.budget);
    const avgBudget = budgets.length > 0 ? Math.round(budgets.reduce((a, b) => a + b, 0) / budgets.length) : 0;

    const hourlies = matched.filter(j => j.hourly_max > 0).map(j => j.hourly_max);
    const avgHourly = hourlies.length > 0 ? Math.round(hourlies.reduce((a, b) => a + b, 0) / hourlies.length) : 0;

    return {
      technology: tech.name,
      total_jobs: totalJobs,
      jobs_last_24h: jobs24h,
      avg_proposals: avgProps,
      low_comp_pct: lowComp,
      avg_budget: avgBudget,
      avg_hourly: avgHourly,
      high_hire_client_pct: highHire
    };
  }).filter(Boolean).sort((a, b) => b.total_jobs - a.total_jobs);
  const countryBreakdown = db.prepare(`
    SELECT
      COALESCE(client_country, 'Unknown') as country,
      COUNT(*) as total_jobs,
      SUM(CASE WHEN datetime(posted_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as jobs_last_24h,
      ROUND(AVG(client_hire_rate), 1) as avg_hire_rate,
      ROUND(SUM(CASE WHEN client_hire_rate >= 60 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as high_hire_pct,
      ROUND(AVG(current_proposals_numeric), 1) as avg_proposals,
      ROUND(AVG(CASE WHEN budget > 0 THEN budget ELSE NULL END), 0) as avg_budget,
      ROUND(AVG(CASE WHEN hourly_max > 0 THEN hourly_max ELSE NULL END), 0) as avg_hourly,
      ROUND(SUM(client_total_spent), 0) as total_client_spend
    FROM jobs
    ${whereClause}
    GROUP BY country
    ORDER BY total_jobs DESC, avg_hire_rate DESC
    LIMIT 12
  `).all();

  // 6. Recent Tracked Jobs with Full Lifecycle Metrics
  const recentJobs = db.prepare(`
    SELECT *
    FROM jobs
    ${whereClause}
    ORDER BY posted_at DESC
    LIMIT 100
  `).all();

  // 7. Sniper Opportunities (Open, Not Ghost, High Sniper Score, Filter-Aware)
  let sniperWhere = `WHERE job_status = 'open' AND is_ghost_job = 0 AND sniper_score >= 60`;
  if (keywordFilter && keywordFilter !== 'ALL') {
    if (keywordFilter.startsWith('GROUP:')) {
      const grp = keywordFilter.slice(6).replace(/'/g, "''");
      sniperWhere += ` AND keyword_matched IN (SELECT keyword FROM tracked_keywords WHERE category = '${grp}')`;
    } else {
      const kw = keywordFilter.replace(/'/g, "''");
      sniperWhere += ` AND keyword_matched = '${kw}'`;
    }
  }

  const sniperOpportunities = db.prepare(`
    SELECT *
    FROM jobs
    ${sniperWhere}
    ORDER BY sniper_score DESC, posted_at DESC
    LIMIT 15
  `).all();

  return {
    generated_at: new Date().toISOString(),
    summary,
    budgetTiers,
    proposalBuckets,
    budgetVsSaturation,
    hireRateCohorts,
    hourlyDistribution,
    timeBlockWindows,
    groupBreakdown,
    keywordBreakdown,
    countryBreakdown,
    techTrends,
    velocityBuckets,
    sniperOpportunities,
    recentJobs
  };
}

module.exports = {
  getFullMarketAnalytics
};
