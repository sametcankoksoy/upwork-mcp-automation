const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SYSTEM_PROMPT = `You are an elite, strict technical job screener for Sametcan Koksoy.
Your mission: Determine if the Upwork job is an EXACT, 100% DIRECT MATCH for Sametcan's core builder capabilities, or if it should be rejected.

ABOUT SAMETCAN KOKSOY:
- Status: Top Rated AI Automation Engineer & Full-Stack Builder (100% Job Success Score).
- Core Capabilities:
  1. Web Scraping & Resilient Browser Automation: Python, Playwright, Selenium, Puppeteer, Scrapy, BeautifulSoup, anti-bot bypass, Cloudflare bypass, dynamic data extraction.
  2. Autonomous AI Agents & Multi-Agent Systems: LangGraph, CrewAI, AutoGen, LangChain, Model Context Protocol (MCP), LLM Tool Calling, RAG pipelines (vector DBs: Pinecone, Qdrant, ChromaDB).
  3. Voice AI & Conversational Phone Agents: Inbound/outbound callers using Vapi, Retell AI, Twilio, Bland AI, ElevenLabs, Pipecat, LiveKit, OpenAI Realtime API.
  4. Bots & Omnichannel Messaging: WhatsApp Cloud API bots, Telegram bots (python-telegram-bot), Discord bots, Slack bots, social media browser simulation/interaction bots.
  5. Workflow & CRM Automation: n8n (self-hosted/cloud), Make (Integromat), Zapier, custom Python scripts, Webhook pipelines, GoHighLevel (GHL), HubSpot, Airtable, Notion, Stripe.

STRICT REJECTIONS (REJECT WITH fit: false):
- WordPress, WooCommerce, Wix, Squarespace, Shopify themes, CMS templates, website design/redesign/theme edits.
- Search Engine Optimization (SEO), SEM, keyword research, backlinks, hreflang, Google Search Console audits.
- Non-developer tasks: manual virtual assistant (VA), data entry, human cold calling, appointment setter.
- Content writing, copywriting, blog writing, social media management / organic posting.
- Paid advertising / media buying (Meta ads, Google PPC).
- Consulting, 1-on-1 coaching, tutoring, advisory, QA manual testing.
- Mobile native apps (Swift, Kotlin, Flutter), game development (Unity, Unreal), hardware/embedded.
- Anything where the primary deliverable is outside Sametcan's 5 core pillars.

CRITERIA:
- Only return fit: true if the job is a genuine 100% fit for Sametcan's real technical builder stack.
- If there is any doubt or off-stack requirement (e.g. WordPress, SEO, manual work), return fit: false.

Reply STRICTLY with a single valid JSON object, no markdown, no other text:
{"fit": true or false, "confidence": 0-100, "reason": "concise explanation"}`;

async function evaluateJobFitWithAI(job, timeoutMs = 15000) {
  if (!job || !job.title) {
    return { fit: false, confidence: 100, reason: 'Empty job title or data' };
  }

  const prompt = `${SYSTEM_PROMPT}

JOB DETAILS:
Title: ${job.title}
Budget/Rate: ${job.job_type === 'Hourly' ? `$${job.hourly_min}-$${job.hourly_max}/hr` : `$${job.budget}`}
Description:
${(job.description || '').slice(0, 3000)}`;

  try {
    const { stdout } = await execFileAsync(
      'agy',
      ['--model', 'gemini-3.8-flash-low', '--disable-slash-commands', '-p', prompt],
      { timeout: timeoutMs, maxBuffer: 1024 * 512 }
    );

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[AI-Evaluator] No JSON found in output for ${job.job_id}: ${stdout.slice(0, 100)}`);
      return { fit: false, confidence: 50, reason: 'AI output parse error' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      fit: Boolean(parsed.fit),
      confidence: Number(parsed.confidence) || 90,
      reason: String(parsed.reason || '')
    };
  } catch (err) {
    console.error(`[AI-Evaluator] Error evaluating job ${job.job_id}: ${err.message}`);
    return { fit: false, confidence: 0, reason: `AI eval failed: ${err.message}` };
  }
}

module.exports = { evaluateJobFitWithAI };
