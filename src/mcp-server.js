const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { db, upsertJobAndSnapshot } = require('./db');
const { getFullMarketAnalytics } = require('./analytics');
const { seedHistoricalDataset } = require('./seed');
const { runTrackerCycle } = require('./upwork-tracker');

// Ensure dataset is initialized
seedHistoricalDataset();

const server = new Server(
  {
    name: 'upwork-market-intelligence-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_upwork_market_stats',
        description:
          'Returns comprehensive Upwork market intelligence: hourly job posting distribution, average minutes to reach 5-10 & 10-15 proposals, ghost job rates, actual hire conversion rates, and client hire rate cohort analysis (>=60% vs <60%).',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: 'Optional keyword filter (e.g. "n8n", "AI Automation", "Voice AI", "MCP Server", or "ALL")',
            },
          },
        },
      },
      {
        name: 'get_sniper_opportunities',
        description:
          'Finds open Upwork jobs where client hire rate is >= 60%, proposals are still low (<10), and ghost job probability is near zero.',
        inputSchema: {
          type: 'object',
          properties: {
            min_hire_rate: {
              type: 'number',
              description: 'Minimum client historical hire rate percentage (default: 60)',
            },
          },
        },
      },
      {
        name: 'ingest_upwork_job_snapshot',
        description:
          'Ingests a job posting or lifecycle snapshot from the official Upwork MCP / GraphQL API into the analytics database to track proposal velocity, ghost status, and hire conversion.',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Upwork Job ID (e.g. ~01...)' },
            title: { type: 'string', description: 'Job title' },
            keyword_matched: { type: 'string', description: 'Category or search keyword' },
            budget: { type: 'number', description: 'Fixed budget in USD' },
            client_hire_rate: { type: 'number', description: 'Client historical hire rate (0-100)' },
            client_total_spent: { type: 'number', description: 'Client total historical spend in USD' },
            current_proposals_tier: {
              type: 'string',
              description: 'Current proposal tier (e.g. "Less than 5", "5 to 10", "10 to 15", "20 to 50")',
            },
            interviewing_count: { type: 'number', description: 'Number of freelancers currently interviewing' },
            hires_count: { type: 'number', description: 'Number of hires made on this job' },
          },
          required: ['job_id', 'title'],
        },
      },
      {
        name: 'trigger_tracker_poll',
        description: 'Triggers an immediate background tracker cycle to update job snapshots and velocity metrics.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'get_upwork_market_stats') {
    const data = getFullMarketAnalytics(args?.keyword || 'ALL');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              summary: data.summary,
              hireRateCohorts: data.hireRateCohorts,
              keywordBreakdown: data.keywordBreakdown,
              velocityBuckets: data.velocityBuckets,
              peakPostingHours: [...data.hourlyDistribution]
                .sort((a, b) => b.jobs_count - a.jobs_count)
                .slice(0, 5),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === 'get_sniper_opportunities') {
    const minRate = args?.min_hire_rate || 60;
    const jobs = db
      .prepare(
        `SELECT job_id, title, keyword_matched, budget, hourly_max, posted_at, client_hire_rate, client_total_spent, current_proposals_tier, sniper_score
         FROM jobs
         WHERE job_status = 'open' AND is_ghost_job = 0 AND client_hire_rate >= ?
         ORDER BY sniper_score DESC, posted_at DESC LIMIT 15`
      )
      .all(minRate);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: jobs.length, opportunities: jobs }, null, 2),
        },
      ],
    };
  }

  if (name === 'ingest_upwork_job_snapshot') {
    const isNew = upsertJobAndSnapshot({
      job_id: args.job_id,
      title: args.title,
      keyword_matched: args.keyword_matched || 'AI Automation',
      budget: args.budget || 0,
      client_hire_rate: args.client_hire_rate ?? 65,
      client_total_spent: args.client_total_spent ?? 10000,
      current_proposals_tier: args.current_proposals_tier || 'Less than 5',
      interviewing_count: args.interviewing_count || 0,
      hires_count: args.hires_count || 0,
      posted_at: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: 'recorded', is_new_job: isNew, job_id: args.job_id }),
        },
      ],
    };
  }

  if (name === 'trigger_tracker_poll') {
    const res = await runTrackerCycle({ simulateStep: true });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(res, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('MCP Server error:', err);
    process.exit(1);
  });
}

module.exports = { server };
