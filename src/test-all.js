const assert = require('node:assert');
const { seedHistoricalDataset } = require('./seed');
const { getFullMarketAnalytics } = require('./analytics');
const { upsertJobAndSnapshot, db } = require('./db');
const { runTrackerCycle } = require('./upwork-tracker');

async function runTests() {
  console.log('=== 1. Testing Database & Seeding ===');
  const seedRes = seedHistoricalDataset(160);
  console.log('Dataset ready:', seedRes);

  console.log('\n=== 2. Testing Market Analytics Engine ===');
  const analytics = getFullMarketAnalytics('ALL');
  assert(analytics.summary.total_jobs >= 160, 'Should have at least 160 tracked jobs');
  assert(analytics.hireRateCohorts.length === 3, 'Should have 3 client hire rate cohorts (60%+, 35-59%, <35%)');
  assert(analytics.hourlyDistribution.length === 24, 'Should have 24 hourly buckets');
  assert(analytics.keywordBreakdown.length >= 6, 'Should have keyword breakdown');

  console.log('Summary KPIs:', {
    total_jobs: analytics.summary.total_jobs,
    avg_mins_to_5_10: analytics.summary.avg_mins_to_5_10,
    avg_mins_to_10_15: analytics.summary.avg_mins_to_10_15,
    hire_conversion_rate: analytics.summary.hire_conversion_rate + '%',
    ghost_job_rate: analytics.summary.ghost_job_rate + '%',
    avg_hours_to_hire: analytics.summary.avg_hours_to_hire + 'h'
  });

  console.log('\n=== 3. Client Hire Rate Cohort Verification (>=60% vs <60%) ===');
  for (const c of analytics.hireRateCohorts) {
    console.log(
      `Cohort [${c.cohort}]: ${c.jobs_posted} jobs | Actual Hire: ${c.actual_hire_conversion_pct}% | Ghost Rate: ${c.ghost_rate_pct}% | 5-10 Apply: ${c.avg_mins_to_5_10_apply}m`
    );
  }

  console.log('\n=== 4. Testing Real-Time Job Lifecycle Transition (t=0 -> 5-10 proposals -> Hired) ===');
  const testJobId = '~01test_lifecycle_job';
  db.prepare('DELETE FROM job_snapshots WHERE job_id = ?').run(testJobId);
  db.prepare('DELETE FROM jobs WHERE job_id = ?').run(testJobId);

  const t0 = new Date(Date.now() - 20 * 60000).toISOString(); // Posted 20 mins ago
  const t1 = new Date(Date.now() - 12 * 60000).toISOString(); // 8 mins after post: hit 5 to 10 proposals
  const t2 = new Date().toISOString(); // 20 mins after post: hired!

  // Snapshot 1: Just posted (<5 proposals)
  upsertJobAndSnapshot({
    job_id: testJobId,
    title: 'Lifecycle Verification Test Job',
    keyword_matched: 'n8n',
    budget: 3500,
    posted_at: t0,
    checked_at: t0,
    client_hire_rate: 85,
    client_total_spent: 50000,
    current_proposals_tier: 'Less than 5',
    current_proposals_numeric: 2
  });

  // Snapshot 2: +8 minutes later, reaches '5 to 10' proposals
  upsertJobAndSnapshot({
    job_id: testJobId,
    title: 'Lifecycle Verification Test Job',
    posted_at: t0,
    checked_at: t1,
    current_proposals_tier: '5 to 10',
    current_proposals_numeric: 7,
    interviewing_count: 1
  });

  // Snapshot 3: +20 minutes later, reaches '10 to 15' proposals and hires 1 freelancer
  upsertJobAndSnapshot({
    job_id: testJobId,
    title: 'Lifecycle Verification Test Job',
    posted_at: t0,
    checked_at: t2,
    current_proposals_tier: '10 to 15',
    current_proposals_numeric: 12,
    interviewing_count: 2,
    hires_count: 1
  });

  const verifiedJob = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(testJobId);
  const snapshots = db.prepare('SELECT * FROM job_snapshots WHERE job_id = ?').all(testJobId);

  assert(snapshots.length === 3, 'Should have recorded 3 lifecycle snapshots');
  assert(verifiedJob.mins_to_5_10_proposals === 8, `Expected 8 mins to 5-10 proposals, got ${verifiedJob.mins_to_5_10_proposals}`);
  assert(verifiedJob.mins_to_10_15_proposals === 20, `Expected 20 mins to 10-15 proposals, got ${verifiedJob.mins_to_10_15_proposals}`);
  assert(verifiedJob.job_status === 'hired', 'Job status should transition to hired');
  console.log('Lifecycle transition test PASSED:', {
    mins_to_5_10: verifiedJob.mins_to_5_10_proposals,
    mins_to_10_15: verifiedJob.mins_to_10_15_proposals,
    mins_to_first_interview: verifiedJob.mins_to_first_interview,
    mins_to_hire: verifiedJob.mins_to_hire,
    status: verifiedJob.job_status
  });

  console.log('\n=== 5. Testing Tracker Poll Cycle ===');
  const pollRes = await runTrackerCycle({ simulateStep: true });
  console.log('Tracker cycle result:', pollRes);

  console.log('\n✅ ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
