const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SYSTEM_PROMPT = `You are an elite, hyper-strict technical job screener for Sametcan Koksoy.
Your mission: Determine if the Upwork job is an EXACT, 100% DIRECT MATCH for Sametcan's core builder capabilities, or if it should be rejected.

CRITICAL REQUIREMENT - READ THE ENTIRE JOB DESCRIPTION THOROUGHLY:
You MUST read and analyze the ENTIRE job description from start to finish, NOT JUST THE TITLE.
Clients frequently use buzzword titles like "AI Automation Specialist", "Python Developer Needed", "AI Chatbot Builder", or "Automation Engineer", but then sneak off-stack surprises or manual chores into the body of the post.
If the description reveals ANY off-stack platform, hidden manual task, language barrier, or out-of-scope deliverable, REJECT IT IMMEDIATELY with fit: false.

ABOUT SAMETCAN KOKSOY:
- Status: Top Rated AI Automation Engineer & Full-Stack Builder (100% Job Success Score).
- ONLY 5 CORE PILLARS ACCEPTED:
  1. Web Scraping & Resilient Browser Automation: Python, Playwright, Selenium, Puppeteer, Scrapy, BeautifulSoup, anti-bot bypass, Cloudflare bypass, dynamic data extraction.
  2. Autonomous AI Agents & Multi-Agent Systems: LangGraph, CrewAI, AutoGen, LangChain, Model Context Protocol (MCP), LLM Tool Calling, RAG pipelines (Pinecone, Qdrant, ChromaDB).
  3. Voice AI & Conversational Phone Agents: Inbound/outbound callers using Vapi, Retell AI, Twilio, Bland AI, ElevenLabs, Pipecat, LiveKit, OpenAI Realtime API.
  4. Bots & Omnichannel Messaging: WhatsApp Cloud API bots, Telegram bots (python-telegram-bot), Discord bots, Slack bots, social media browser simulation/interaction bots.
  5. Workflow & CRM Automation: n8n (self-hosted/cloud), Make (Integromat), Zapier, custom Python scripts, Webhook pipelines, GoHighLevel (GHL), HubSpot, Airtable, Notion, Stripe.

STRICT REJECTIONS - ZERO TOLERANCE (REJECT WITH fit: false):
- CMS / E-Commerce Platforms: WordPress, WooCommerce, Elementor, Divi, Wix, Squarespace, Webflow, Shopify themes/apps, Drupal, Magento, Joomla, Prestashop. We are NOT WordPress/CMS developers under any circumstances!
- Search Engine Optimization (SEO), SEM, keyword research, backlinks, hreflang, Google Search Console audits.
- Non-Developer / Manual Tasks: Virtual assistant (VA), manual data entry, copy-pasting, human cold calling, telemarketing, appointment setting, customer support, lead enrichment lists.
- Content & Media: Copywriting, blog writing, article writing, social media management, organic posting, video editing, translation.
- Language barriers: Specific non-English fluency requirements (e.g. "must speak fluent German/Spanish/French").
- Consulting / Non-Build: 1-on-1 coaching, tutoring, training, pure advisory, QA manual testing, architecture audit without building.
- Unrelated Engineering: Mobile native apps (Swift, Kotlin, Flutter), game development (Unity, Unreal), hardware/embedded systems, C++, C#, .NET.
- Anything where the actual hands-on deliverable is not 100% inside Sametcan's 5 core builder pillars.

CRITERIA:
- Only return fit: true if the job is a genuine 100% fit for Sametcan's real technical builder stack.
- If there is any doubt or off-stack requirement anywhere in the text, return fit: false.

Reply STRICTLY with a single valid JSON object, no markdown, no other text:
{"fit": true or false, "confidence": 0-100, "reason": "concise explanation evaluating the full description"}`;

async function evaluateJobFitWithAI(job, timeoutMs = 15000) {
  if (!job || !job.title) {
    return { fit: false, confidence: 100, reason: 'Empty job title or data' };
  }

  const desc = String(job.description || '').slice(0, 4500);
  const prompt = `${SYSTEM_PROMPT}

JOB DETAILS:
Title: ${job.title}
Budget/Rate: ${job.job_type === 'Hourly' ? `$${job.hourly_min}-$${job.hourly_max}/hr` : `$${job.budget}`}
Full Description:
${desc}`;

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
