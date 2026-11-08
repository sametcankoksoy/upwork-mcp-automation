const { db } = require('./db');

function getFullMarketAnalytics(keywordFilter = null) {
  const whereClause = keywordFilter && keywordFilter !== 'ALL'
    ? `WHERE keyword_matched = ${db.prepare('SELECT ?').get(keywordFilter) ? `'${keywordFilter.replace(/'/g, "''")}'` : 'keyword_matched'}`
    : '';

  // 1. High-level KPI Summary
  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_jobs,
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

  // 2. Client Hire Rate Cohort Analysis (>= 60% vs 35-59% vs < 35%)
  const hireRateCohorts = db.prepare(`
    SELECT
      CASE
        WHEN client_hire_rate >= 60 THEN '60%+ High Hire Rate (Whales)'
        WHEN client_hire_rate >= 35 THEN '35% - 59% Medium Hire Rate'
        ELSE 'Under 35% Low Hire Rate'
      END as cohort,
      COUNT(*) as jobs_posted,
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
    // Opportunity Ratio: High Hire Rate + Low Proposals + Slow Saturation
    const compScore = row.jobs_count > 0
      ? Math.round(
          (row.hire_rate_pct * 0.5) +
          (Math.max(0, 40 - (row.avg_total_proposals || 20)) * 1.1) +
          (Math.min(40, row.avg_mins_to_5_10 || 20) * 0.6)
        )
      : 0;
    hourlyDistribution.push({
      ...row,
      opportunity_score: Math.min(100, Math.max(0, compScore)),
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
    const weighted5_10 = totalJobs > 0
      ? Math.round((slice.reduce((a, b) => a + ((b.avg_mins_to_5_10 || 25) * b.jobs_count), 0) / totalJobs) * 10) / 10
      : 0;
    const weightedHire = totalJobs > 0
      ? Math.round((slice.reduce((a, b) => a + (b.hire_rate_pct * b.jobs_count), 0) / totalJobs) * 10) / 10
      : 0;
    const lowCompCount = slice.reduce((a, b) => a + (b.low_competition_jobs || 0), 0);
    const lowCompPct = totalJobs > 0 ? Math.round((lowCompCount / totalJobs) * 1000) / 10 : 0;

    const startTrt = (startUtc + 3) % 24;
    const endTrt = (startTrt + 3) % 24;

    timeBlockWindows.push({
      block_utc: `${String(startUtc).padStart(2, '0')}:00 - ${String((startUtc + 3) % 24).padStart(2, '0')}:00 UTC`,
      block_trt: `${String(startTrt).padStart(2, '0')}:00 - ${String(endTrt).padStart(2, '0')}:00 (UTC+3)`,
      total_jobs: totalJobs,
      avg_proposals_per_job: weightedProps,
      avg_mins_to_5_10: weighted5_10,
      low_competition_pct: lowCompPct,
      hire_rate_pct: weightedHire,
      competition_level: weightedProps <= 12 ? 'Low Competition (Golden Window)' : (weightedProps <= 20 ? 'Moderate Competition' : 'High Competition (Crowded)')
    });
  }
  timeBlockWindows.sort((a, b) => a.avg_proposals_per_job - b.avg_proposals_per_job);

  // 4. Keyword / Niche Breakdown (Velocity, Ghost Rate, Hire Rate)
  const keywordBreakdown = db.prepare(`
    SELECT
      keyword_matched as keyword,
      COUNT(*) as total_jobs,
      ROUND(AVG(mins_to_5_10_proposals), 1) as avg_mins_to_5_10,
      ROUND(AVG(mins_to_10_15_proposals), 1) as avg_mins_to_10_15,
      ROUND(SUM(CASE WHEN job_status = 'hired' OR hires_count > 0 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as hire_conversion_pct,
      ROUND(SUM(CASE WHEN is_ghost_job = 1 OR job_status = 'ghost' THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as ghost_rate_pct,
      ROUND(SUM(CASE WHEN client_hire_rate >= 60 THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) as high_hire_client_pct,
      ROUND(AVG(CASE WHEN budget > 0 THEN budget ELSE NULL END), 0) as avg_budget
    FROM jobs
    GROUP BY keyword_matched
    ORDER BY total_jobs DESC
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

  // 6. Recent Tracked Jobs with Full Lifecycle Metrics
  const recentJobs = db.prepare(`
    SELECT *
    FROM jobs
    ${whereClause}
    ORDER BY posted_at DESC
    LIMIT 60
  `).all();

  // 7. Sniper Opportunities (Open, Client Hire Rate >= 60%, < 10 proposals, not ghost)
  const sniperOpportunities = db.prepare(`
    SELECT *
    FROM jobs
    WHERE job_status = 'open'
      AND is_ghost_job = 0
      AND client_hire_rate >= 60
      AND current_proposals_numeric <= 10
    ORDER BY sniper_score DESC, posted_at DESC
    LIMIT 15
  `).all();

  return {
    generated_at: new Date().toISOString(),
    summary,
    hireRateCohorts,
    hourlyDistribution,
    timeBlockWindows,
    keywordBreakdown,
    velocityBuckets,
    sniperOpportunities,
    recentJobs
  };
}

module.exports = {
  getFullMarketAnalytics
};
