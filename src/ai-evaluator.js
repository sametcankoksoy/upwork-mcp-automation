const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SYSTEM_PROMPT = `You are an elite, strict technical job screener for Sametcan Koksoy.
Your mission: Determine if the Upwork job is an EXACT MATCH for Sametcan's core builder capabilities or an absolute mismatch that will waste money and connects.

SAMETCAN'S CORE STACK (APPROVE ONLY THESE):
1. Web Scraping & Browser Automation: Python/Node, Playwright, Selenium, Puppeteer, Scrapy, BeautifulSoup, anti-bot bypass, Cloudflare bypass, data extraction pipelines.
2. Bots & Conversational Systems: WhatsApp bots, Telegram bots, Discord bots, Slack bots.
3. Voice Agents & Call Automation: Vapi, Retell AI, Twilio, ElevenLabs, Bland AI, Pipecat, LiveKit.
4. Python & Workflow Automation: n8n, Make.com, Python scripts, API integrations, webhooks, multi-account browser automation, simulating interactions.
5. AI Engineering: Multi-agent systems, MCP servers, RAG pipelines, LLM tool calling.

STRICT REJECTIONS (REJECT WITH fit: false):
- Search Engine Optimization (SEO), SEM, keyword research, backlinks, hreflang, Google Search Console audits.
- Language/translation requirements (Spanish, French, German, bilingual translation, multilingual content).
- Content writing, copywriting, blog writing, social media management / organic posting.
- Paid advertising / media buying (Meta ads, Google PPC).
- Consulting, 1-on-1 coaching, tutoring, advisory, QA manual testing.
- Mobile native apps (Swift, Kotlin, Flutter), game development (Unity, Unreal), hardware/embedded.

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
