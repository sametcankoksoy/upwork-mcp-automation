/**
 * Upwork MCP Central Rate Limiter & Compliance Engine
 * 
 * Strictly complies with official Upwork Model Context Protocol (MCP) limits:
 * - Search & discovery: 15/min, 150/hr, 750/day (Safe: 12/min, 120/hr, 600/day)
 * - Profile viewing:    5/min, 75/hr, 250/day   (Safe: 4/min, 60/hr, 200/day)
 * - Other read:         20/min, 250/hr, 750/day (Safe: 16/min, 200/hr, 650/day)
 * - Proposals & posts:  20/min, 60/hr, 150/day  (Safe: 10/min, 40/hr, 50/day)
 * - Other changes:      4/min, 15/hr, 40/day    (Safe: 3/min, 10/hr, 30/day)
 * 
 * Resets daily quotas at 00:00 UTC.
 * Serializes all requests through a queue to prevent race conditions or bursting.
 */

const { getSetting, setSetting } = require('./db');

const UPWORK_LIMITS = {
  search: {
    official: { min: 15, hour: 150, day: 750 },
    safe:     { min: 12, hour: 120, day: 600 },
    minDelayMs: 5000 // At least 5s between searches
  },
  profile: {
    official: { min: 5, hour: 75, day: 250 },
    safe:     { min: 4, hour: 60, day: 200 },
    minDelayMs: 14000 // At least 14s between profile views (strictest per-minute bottleneck)
  },
  read: {
    official: { min: 20, hour: 250, day: 750 },
    safe:     { min: 16, hour: 200, day: 650 },
    minDelayMs: 3500 // At least 3.5s between general reads
  },
  proposal: {
    official: { min: 20, hour: 60, day: 150 },
    safe:     { min: 10, hour: 40, day: 50 },
    minDelayMs: 5000 // At least 5s between proposal previews/submits
  },
  change: {
    official: { min: 4, hour: 15, day: 40 },
    safe:     { min: 3, hour: 10, day: 30 },
    minDelayMs: 18000 // At least 18s between record updates
  }
};

const GLOBAL_MIN_DELAY_MS = 1000; // Never send two calls within 1 second

class UpworkMcpRateLimiter {
  constructor() {
    this.history = {
      search: [],
      profile: [],
      read: [],
      proposal: [],
      change: []
    };
    this.lastCallByCategory = {};
    this.lastGlobalCallTime = 0;
    this.cooldownUntilByCategory = {};

    this.queue = [];
    this.isProcessingQueue = false;

    // Load persisted daily stats
    this._syncFromDb();
  }

  _getUtcDay() {
    return new Date().toISOString().slice(0, 10);
  }

  _syncFromDb() {
    const today = this._getUtcDay();
    const stored = getSetting('mcp_rate_limit_daily') || {};
    if (stored.date !== today) {
      this.dailyCounts = {
        date: today,
        search: 0,
        profile: 0,
        read: 0,
        proposal: 0,
        change: 0
      };
      setSetting('mcp_rate_limit_daily', this.dailyCounts);
    } else {
      this.dailyCounts = {
        date: today,
        search: Number(stored.search || 0),
        profile: Number(stored.profile || 0),
        read: Number(stored.read || 0),
        proposal: Number(stored.proposal || 0),
        change: Number(stored.change || 0)
      };
    }
  }

  _saveDailyToDb() {
    try {
      setSetting('mcp_rate_limit_daily', this.dailyCounts);
    } catch {}
  }

  classifyCall(toolName, args = {}) {
    if (toolName === 'upwork__find_jobs') {
      const action = args?.action;
      if (action === 'get' || args?.params?.job_id) {
        return 'profile';
      }
      return 'search';
    }
    if (toolName === 'upwork__manage_proposals') {
      return 'proposal';
    }
    if (toolName === 'upwork__list_accounts' || toolName === 'upwork__get_freelancer_dashboard') {
      return 'read';
    }
    if (/search|find/i.test(toolName)) return 'search';
    if (/profile|client|talent|user/i.test(toolName)) return 'profile';
    if (/proposal|offer|apply|post/i.test(toolName)) return 'proposal';
    if (/update|create|edit|change|delete|cancel/i.test(toolName)) return 'change';
    return 'read';
  }

  _cleanHistory(category, now) {
    const oneHourAgo = now - 3600000;
    this.history[category] = this.history[category].filter(ts => ts > oneHourAgo);
  }

  getCounts(category) {
    this._syncFromDb();
    const now = Date.now();
    this._cleanHistory(category, now);

    const oneMinuteAgo = now - 60000;
    const minCount = this.history[category].filter(ts => ts > oneMinuteAgo).length;
    const hourCount = this.history[category].length;
    const dayCount = this.dailyCounts[category] || 0;

    return { minCount, hourCount, dayCount };
  }

  getDiagnostics() {
    this._syncFromDb();
    const now = Date.now();
    const stats = {};
    for (const cat of Object.keys(UPWORK_LIMITS)) {
      this._cleanHistory(cat, now);
      const counts = this.getCounts(cat);
      const limits = UPWORK_LIMITS[cat];
      stats[cat] = {
        last_minute: `${counts.minCount}/${limits.safe.min} (max ${limits.official.min})`,
        last_hour: `${counts.hourCount}/${limits.safe.hour} (max ${limits.official.hour})`,
        today_utc: `${counts.dayCount}/${limits.safe.day} (max ${limits.official.day})`
      };
    }
    return {
      utc_date: this.dailyCounts.date,
      categories: stats,
      queue_length: this.queue.length
    };
  }

  async acquireSlot(category) {
    while (true) {
      this._syncFromDb();
      const now = Date.now();
      const limits = UPWORK_LIMITS[category];
      const counts = this.getCounts(category);

      // 1. Check Day Quota
      if (counts.dayCount >= limits.safe.day) {
        throw new Error(`UPWORK_MCP_DAILY_QUOTA_REACHED: Category '${category}' reached daily limit (${counts.dayCount}/${limits.official.day}). Resets at 00:00 UTC.`);
      }

      // 2. Check Cooldown (e.g. from rate limit error)
      const cooldownUntil = this.cooldownUntilByCategory[category] || 0;
      if (cooldownUntil > now) {
        const waitMs = cooldownUntil - now;
        console.log(`[Upwork-RateLimiter] Category '${category}' in backoff cooldown for ${Math.round(waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // 3. Check Hour Quota
      if (counts.hourCount >= limits.safe.hour) {
        const oldest = this.history[category][0] || now;
        const waitMs = Math.max(1000, 3600000 - (now - oldest) + 500);
        console.warn(`[Upwork-RateLimiter] Category '${category}' hourly limit reached (${counts.hourCount}/${limits.safe.hour}). Waiting ${Math.round(waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, Math.min(waitMs, 30000)));
        continue;
      }

      // 4. Check Minute Quota & Delays
      let waitMs = 0;
      if (counts.minCount >= limits.safe.min) {
        const oneMinuteAgo = now - 60000;
        const recent = this.history[category].filter(ts => ts > oneMinuteAgo);
        const oldestRecent = recent[0] || now;
        waitMs = Math.max(waitMs, 60000 - (now - oldestRecent) + 200);
      }

      const lastCatCall = this.lastCallByCategory[category] || 0;
      const catElapsed = now - lastCatCall;
      if (catElapsed < limits.minDelayMs) {
        waitMs = Math.max(waitMs, limits.minDelayMs - catElapsed);
      }

      const globalElapsed = now - this.lastGlobalCallTime;
      if (globalElapsed < GLOBAL_MIN_DELAY_MS) {
        waitMs = Math.max(waitMs, GLOBAL_MIN_DELAY_MS - globalElapsed);
      }

      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // Slot granted
      const grantedTime = Date.now();
      this.history[category].push(grantedTime);
      this.lastCallByCategory[category] = grantedTime;
      this.lastGlobalCallTime = grantedTime;
      this.dailyCounts[category] = (this.dailyCounts[category] || 0) + 1;
      this._saveDailyToDb();
      return;
    }
  }

  notifyRateLimitError(category, errorCode, retryAfterSec = 15) {
    const now = Date.now();
    const cooldownMs = Math.max(10000, (retryAfterSec || 15) * 1000);
    this.cooldownUntilByCategory[category] = now + cooldownMs;
    console.warn(`[Upwork-RateLimiter] Rate limit signal received for '${category}' (${errorCode}). Pausing category for ${Math.round(cooldownMs / 1000)}s.`);
  }

  /**
   * Enqueues an MCP request and executes it when a compliant slot is available.
   */
  async execute(toolName, args, executeFn) {
    const category = this.classifyCall(toolName, args);

    return new Promise((resolve, reject) => {
      this.queue.push({
        toolName,
        args,
        category,
        executeFn,
        resolve,
        reject
      });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        await this.acquireSlot(item.category);
        const result = await item.executeFn();
        item.resolve(result);
      } catch (err) {
        const errMsg = String(err.message || '');
        if (/SENSITIVE_RATE_LIMIT_EXCEEDED|RATE_LIMIT_EXCEEDED|429/i.test(errMsg)) {
          this.notifyRateLimitError(item.category, 'RATE_LIMIT_EXCEEDED', 15);
        }
        item.reject(err);
      }
    }

    this.isProcessingQueue = false;
  }
}

const rateLimiter = new UpworkMcpRateLimiter();

module.exports = {
  rateLimiter,
  UPWORK_LIMITS
};
