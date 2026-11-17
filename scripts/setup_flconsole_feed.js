const { callFlconsoleMcp } = require('../src/flconsole-tracker');

(async () => {
  try {
    const feedRes = await callFlconsoleMcp('tools/call', {
      name: 'create_feed',
      arguments: {
        name: 'AI & Browser Automation Radar',
        alerts: true,
        user_confirmed: true,
        filters: {
          schema_version: 1,
          base: {
            q: 'Playwright OR "Web Scraping" OR "AI Agent" OR "Python Automation" OR "Browser Automation"',
            payment_verified: true
          }
        },
        ai_filter: 'Keep jobs about web scraping, browser automation, AI agents, LLM integrations, Python/Node backend systems, and data extraction pipelines. Skip generic data entry, virtual assistance, and unrelated mobile apps.'
      }
    });
    console.log('Feed created successfully:', JSON.stringify(feedRes, null, 2));
  } catch (err) {
    console.error('Create feed error:', err.message);
  }
})();
