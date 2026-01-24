const express = require('express');
const winston = require('winston');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const Redis = require('redis');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const Stripe = require('stripe');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Config from env
const CONFIG = {
  port: process.env.PORT || 3000,
  githubToken: process.env.GITHUB_TOKEN,
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  xaiKey: process.env.XAI_API_KEY,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  stripeKey: process.env.STRIPE_SECRET_KEY,
  telegramToken: process.env.TELEGRAM_TOKEN,
  channelId: process.env.CHANNEL_ID,
  defaultOwner: process.env.DEFAULT_OWNER || 'ivan09069',
  defaultRepo: process.env.DEFAULT_REPO || 'issue-whisperer'
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Redis client
let redis;
async function initRedis() {
  try {
    redis = Redis.createClient({ url: CONFIG.redisUrl });
    redis.on('error', err => logger.error('Redis error:', err));
    await redis.connect();
    logger.info('Redis connected');
  } catch (err) {
    logger.warn('Redis unavailable, running without cache:', err.message);
    redis = null;
  }
}

// Stripe (optional)
const stripe = CONFIG.stripeKey ? new Stripe(CONFIG.stripeKey) : null;

// Telegram Bot (optional)
const bot = CONFIG.telegramToken ? new TelegramBot(CONFIG.telegramToken, { polling: false }) : null;

// GitHub client
const octokit = new Octokit({ auth: CONFIG.githubToken });

// Signature verification
function verifySignature(payload, signature) {
  if (!CONFIG.webhookSecret) return true;
  const hmac = crypto.createHmac('sha256', CONFIG.webhookSecret);
  hmac.update(JSON.stringify(payload));
  const digest = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(digest));
  } catch {
    return false;
  }
}

// Python analyzer with retry
async function runAnalyzer(title, body = '', retries = 3) {
  for (let r = 0; r < retries; r++) {
    try {
      return await new Promise((resolve, reject) => {
        const python = spawn('python', [path.join(__dirname, 'analyze_issue.py'), title, body]);
        const timeout = setTimeout(() => {
          python.kill();
          resolve({ label: 'triage', dupe: 'None', draft: 'Thanks for reporting! (Timeout)' });
        }, 8000);
        
        let output = '';
        let errorOutput = '';
        python.stdout.on('data', data => output += data.toString());
        python.stderr.on('data', data => errorOutput += data.toString());
        
        python.on('close', code => {
          clearTimeout(timeout);
          if (code === 0) {
            const lines = output.trim().split('\n').map(s => s.trim());
            resolve({
              label: lines[0] || 'triage',
              dupe: lines[1] || 'None',
              draft: lines[2] || 'Thanks for reporting!'
            });
          } else {
            reject(new Error(`Python exit ${code}: ${errorOutput}`));
          }
        });
      });
    } catch (err) {
      logger.error(`Analyzer attempt ${r + 1} failed:`, err.message);
      if (r < retries - 1) await new Promise(resolve => setTimeout(resolve, 1000 * (r + 1)));
      else return { label: 'triage', dupe: 'None', draft: 'Thanks for reporting! (Analysis failed)' };
    }
  }
}

// Pro tier check
async function checkProTier(repoFullName) {
  if (!stripe) return true; // No Stripe = everyone is Pro
  const userId = repoFullName.split('/')[0];
  try {
    const customers = await stripe.customers.list({ email: `${userId}@github.users` });
    if (customers.data.length === 0) return false;
    const subs = await stripe.subscriptions.list({ customer: customers.data[0].id, status: 'active' });
    return subs.data.length > 0;
  } catch (err) {
    logger.warn('Stripe check failed, defaulting to Pro:', err.message);
    return true;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', redis: !!redis, timestamp: new Date().toISOString() });
});

// Main webhook
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  const signature = req.get('X-Hub-Signature-256');

  try {
    if (!verifySignature(req.body, signature)) {
      logger.warn('Invalid signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { repository, issue, action } = req.body;
    if (!repository || !issue || action !== 'opened') {
      return res.status(200).json({ status: 'ignored', reason: 'Not an issue open event' });
    }

    const owner = repository.owner.login;
    const repo = repository.name;
    const repoFullName = repository.full_name;
    const issueNumber = issue.number;
    const title = issue.title || 'Untitled';
    const body = issue.body || '';

    logger.info(`Processing #${issueNumber} in ${repoFullName}`);

    // Check cache
    const cacheKey = `processed:${repoFullName}:${issueNumber}`;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info(`Already processed #${issueNumber}`);
        return res.status(200).json({ status: 'cached' });
      }
    }

    // Pro tier check
    const isPro = await checkProTier(repoFullName);
    let suggestions = { label: 'triage', dupe: 'None', draft: 'Thanks for reporting! Our team will review this shortly.' };
    
    if (isPro) {
      suggestions = await runAnalyzer(title, body);
    }

    // Apply label and comment
    let success = true;
    try {
      if (suggestions.label && suggestions.label !== 'triage') {
        await octokit.rest.issues.addLabels({
          owner, repo,
          issue_number: issueNumber,
          labels: [suggestions.label]
        });
      }

      let commentBody = suggestions.draft;
      if (suggestions.dupe && suggestions.dupe !== 'None') {
        commentBody += `\n\n🔗 Possible duplicate: ${suggestions.dupe}`;
      }
      commentBody += '\n\n---\n*Powered by [Issue Whisperer](https://github.com/apps/issue-whisperer)*';

      await octokit.rest.issues.createComment({
        owner, repo,
        issue_number: issueNumber,
        body: commentBody
      });
    } catch (err) {
      success = false;
      logger.error('GitHub API failed:', err.message);
    }

    // Cache result
    if (redis && success) {
      await redis.set(cacheKey, JSON.stringify(suggestions), { EX: 86400 });
    }

    const latency = Date.now() - startTime;
    logger.info(`Processed #${issueNumber} in ${latency}ms | Pro: ${isPro} | Label: ${suggestions.label}`);

    // Telegram alert
    if (bot && CONFIG.channelId) {
      bot.sendMessage(CONFIG.channelId, 
        `🎫 Issue #${issueNumber} triaged\n📁 ${repoFullName}\n🏷️ ${suggestions.label}\n⏱️ ${latency}ms`
      ).catch(err => logger.warn('Telegram failed:', err.message));
    }

    res.status(200).json({
      status: 'processed',
      issue: issueNumber,
      label: suggestions.label,
      latency_ms: latency
    });

  } catch (err) {
    logger.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Polling fallback (every 5 mins)
cron.schedule('*/5 * * * *', async () => {
  logger.info('Running polling check...');
  try {
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner: CONFIG.defaultOwner,
      repo: CONFIG.defaultRepo,
      state: 'open',
      since: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    });

    for (const issue of issues) {
      if (issue.pull_request) continue;
      
      const cacheKey = `processed:${CONFIG.defaultOwner}/${CONFIG.defaultRepo}:${issue.number}`;
      if (redis) {
        const cached = await redis.get(cacheKey);
        if (cached) continue;
      }

      const suggestions = await runAnalyzer(issue.title, issue.body);
      
      if (suggestions.label !== 'triage') {
        await octokit.rest.issues.addLabels({
          owner: CONFIG.defaultOwner,
          repo: CONFIG.defaultRepo,
          issue_number: issue.number,
          labels: [suggestions.label]
        });
      }

      let commentBody = suggestions.draft;
      if (suggestions.dupe !== 'None') {
        commentBody += `\n\n🔗 Possible duplicate: ${suggestions.dupe}`;
      }
      commentBody += '\n\n---\n*Powered by [Issue Whisperer](https://github.com/apps/issue-whisperer)*';

      await octokit.rest.issues.createComment({
        owner: CONFIG.defaultOwner,
        repo: CONFIG.defaultRepo,
        issue_number: issue.number,
        body: commentBody
      });

      if (redis) {
        await redis.set(cacheKey, 'true', { EX: 86400 });
      }
      
      logger.info(`Polled issue #${issue.number} | Label: ${suggestions.label}`);
    }
  } catch (err) {
    logger.error('Polling failed:', err.message);
  }
});

// Startup
async function start() {
  await initRedis();
  app.listen(CONFIG.port, () => {
    logger.info(`Issue Whisperer running on port ${CONFIG.port}`);
    logger.info(`Owner: ${CONFIG.defaultOwner}, Repo: ${CONFIG.defaultRepo}`);
    logger.info(`Redis: ${!!redis}, Stripe: ${!!stripe}, Telegram: ${!!bot}`);
  });
}

start().catch(err => {
  logger.error('Startup failed:', err);
  process.exit(1);
});
