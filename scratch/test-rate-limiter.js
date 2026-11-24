const assert = require('node:assert');
const { rateLimiter, UPWORK_LIMITS } = require('../src/mcp-rate-limiter');

async function testRateLimiter() {
  console.log('--- 1. Testing Tool Classification ---');
  assert.strictEqual(rateLimiter.classifyCall('upwork__find_jobs', { action: 'search' }), 'search');
  assert.strictEqual(rateLimiter.classifyCall('upwork__find_jobs', { action: 'smart_search' }), 'search');
  assert.strictEqual(rateLimiter.classifyCall('upwork__find_jobs', { action: 'get', params: { job_id: '123' } }), 'profile');
  assert.strictEqual(rateLimiter.classifyCall('upwork__manage_proposals', { action: 'create_preview' }), 'proposal');
  assert.strictEqual(rateLimiter.classifyCall('upwork__manage_proposals', { action: 'confirm_preview' }), 'proposal');
  assert.strictEqual(rateLimiter.classifyCall('upwork__list_accounts', {}), 'read');
  assert.strictEqual(rateLimiter.classifyCall('upwork__get_freelancer_dashboard', {}), 'read');
  console.log('✅ Tool classification verified.');

  console.log('--- 2. Testing Limits Definition ---');
  assert.strictEqual(UPWORK_LIMITS.search.official.day, 750);
  assert.strictEqual(UPWORK_LIMITS.profile.official.day, 250);
  assert.strictEqual(UPWORK_LIMITS.read.official.day, 750);
  assert.strictEqual(UPWORK_LIMITS.proposal.official.day, 150);
  assert.strictEqual(UPWORK_LIMITS.change.official.day, 40);
  console.log('✅ Official Upwork limits verified.');

  console.log('--- 3. Testing Diagnostics Output ---');
  const diag = rateLimiter.getDiagnostics();
  assert(diag.categories.search, 'Should contain search category');
  assert(diag.categories.profile, 'Should contain profile category');
  assert(diag.categories.proposal, 'Should contain proposal category');
  console.log('Diagnostics snapshot:', JSON.stringify(diag, null, 2));

  console.log('--- 4. Testing Backoff Cooldown Signal ---');
  rateLimiter.notifyRateLimitError('search', 'SENSITIVE_RATE_LIMIT_EXCEEDED', 2);
  assert(rateLimiter.cooldownUntilByCategory['search'] > Date.now(), 'Cooldown should be set');
  console.log('✅ Backoff cooldown signal verified.');

  console.log('\n🎉 ALL RATE LIMITER TESTS PASSED SUCCESSFULLY!');
}

testRateLimiter().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
