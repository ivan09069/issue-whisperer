const express = require('express');
const winston = require('winston');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const OpenAI = require('openai');
const Stripe = require('stripe');
const { createClient } = require('redis');

const app = express();
// Stripe requires raw body for signature verification. Keep this before express.json().
app.use('/stripe-webhook', express.raw({ type: 'application/json', limit: '2mb' }));

// Increase limit to handle larger payloads, but add validation in webhook handler
app.use(express.json({ limit: '10mb' }));

// Config
const CONFIG = {
  port: process.env.PORT || 3000,
  githubToken: process.env.GITHUB_TOKEN,
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  groqKey: process.env.GROQ_API_KEY,
  telegramToken: process.env.TELEGRAM_TOKEN,
  channelId: process.env.CHANNEL_ID,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  redisUrl: process.env.REDIS_URL,
  featureProProductId: process.env.FEATURE_PRO_PRODUCT_ID,
  defaultOwner: process.env.DEFAULT_OWNER || 'ivan09069',
  defaultRepo: process.env.DEFAULT_REPO || 'issue-whisperer',
  aiModel: process.env.AI_MODEL || 'llama-3.3-70b-versatile'
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

// Handle JSON parsing errors gracefully (must be after logger initialization)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.error('Invalid JSON payload:', err.message);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  if (err.type === 'entity.too.large') {
    logger.error('Payload too large');
    return res.status(413).json({ error: 'Payload too large' });
  }
  next(err);
});

// Groq client
const groq = new OpenAI({
  apiKey: CONFIG.groqKey,
  baseURL: 'https://api.groq.com/openai/v1'
});

// GitHub client
const octokit = new Octokit({ auth: CONFIG.githubToken });

// Telegram (optional)
const bot = CONFIG.telegramToken ? new TelegramBot(CONFIG.telegramToken, { polling: false }) : null;

// Stripe (optional)
const stripe = CONFIG.stripeSecretKey ? new Stripe(CONFIG.stripeSecretKey, {
  apiVersion: '2024-06-20'
}) : null;

// Redis-backed idempotency (optional, falls back to memory)
const redis = CONFIG.redisUrl ? createClient({ url: CONFIG.redisUrl }) : null;
const stripeEventCache = new Set();

if (redis) {
  redis.on('error', (err) => logger.error('Redis error:', err.message));
  redis.connect()
    .then(() => logger.info('Redis connected'))
    .catch((err) => logger.error('Redis connect failed:', err.message));
}

async function markOnce(key, ttlSeconds = 86400) {
  if (redis?.isOpen) {
    const result = await redis.set(key, '1', { NX: true, EX: ttlSeconds });
    return result === 'OK';
  }

  if (stripeEventCache.has(key)) return false;
  stripeEventCache.add(key);
  return true;
}

function logTransition(event, data = {}) {
  logger.info('transition', { event, ...data });
}

// Processed issues cache (in-memory for simplicity)
const processedCache = new Set();

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

// AI Analyzer
async function analyzeIssue(title, body = '') {
  // Truncate body to prevent OOM with very large issue descriptions
  const MAX_BODY_LENGTH = 8000; // ~8KB, safe for AI processing
  const truncatedBody = body && body.length > MAX_BODY_LENGTH 
    ? body.substring(0, MAX_BODY_LENGTH) + '... [truncated]'
    : body;
  
  const prompt = `Analyze this GitHub issue and provide triage suggestions.

Title: ${title}
Body: ${truncatedBody || '(No description)'}

Return ONLY valid JSON with these exact fields:
{"label": "bug|enhancement|question|documentation|triage", "dupe": "None", "draft": "brief helpful response"}`;

  try {
    const response = await groq.chat.completions.create({
      model: CONFIG.aiModel,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 200,
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0].message.content);
    const validLabels = ['bug', 'enhancement', 'question', 'documentation', 'triage'];
    return {
      label: validLabels.includes(result.label?.toLowerCase()) ? result.label.toLowerCase() : 'triage',
      dupe: result.dupe || 'None',
      draft: result.draft || 'Thanks for reporting!'
    };
  } catch (err) {
    logger.error('AI analysis failed:', err.message);
    return { label: 'triage', dupe: 'None', draft: 'Thanks for reporting! Our team will review this shortly.' };
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ name: 'Issue Whisperer', version: '1.0.0', status: 'running' });
});


// Stripe webhook handler
app.post('/stripe-webhook', async (req, res) => {
  const startTime = Date.now();

  if (!stripe || !CONFIG.stripeWebhookSecret) {
    logTransition('stripe_webhook_not_configured');
    return res.status(503).json({ error: 'Stripe webhook not configured' });
  }

  const signature = req.get('stripe-signature');
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, CONFIG.stripeWebhookSecret);
  } catch (err) {
    logTransition('stripe_webhook_signature_failed', { message: err.message });
    return res.status(400).json({ error: 'Invalid Stripe signature' });
  }

  const eventKey = `stripe:event:${event.id}`;
  const firstSeen = await markOnce(eventKey, 3 * 24 * 60 * 60);

  if (!firstSeen) {
    logTransition('stripe_webhook_duplicate', {
      id: event.id,
      type: event.type
    });
    return res.status(200).json({ status: 'already_processed', id: event.id });
  }

  try {
    logTransition('stripe_webhook_received', {
      id: event.id,
      type: event.type,
      livemode: event.livemode
    });

    switch (event.type) {
      case 'checkout.session.completed':
        logTransition('stripe_checkout_completed', {
          id: event.id,
          customer: event.data.object.customer || null,
          subscription: event.data.object.subscription || null
        });
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        logTransition('stripe_subscription_transition', {
          id: event.id,
          subscription: event.data.object.id,
          status: event.data.object.status || null,
          customer: event.data.object.customer || null
        });
        break;

      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
        logTransition('stripe_invoice_transition', {
          id: event.id,
          invoice: event.data.object.id,
          customer: event.data.object.customer || null,
          subscription: event.data.object.subscription || null,
          paid: event.data.object.paid || false
        });
        break;

      default:
        logTransition('stripe_webhook_ignored', {
          id: event.id,
          type: event.type
        });
    }

    return res.json({
      status: 'processed',
      id: event.id,
      type: event.type,
      latency_ms: Date.now() - startTime
    });
  } catch (err) {
    logTransition('stripe_webhook_error', {
      id: event.id,
      type: event.type,
      message: err.message
    });
    return res.status(500).json({ error: 'Stripe webhook processing failed' });
  }
});

// Webhook handler
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  const signature = req.get('X-Hub-Signature-256');

  // Express JSON parser already enforces 10MB limit, so we focus on 
  // validating issue body size to prevent OOM during AI processing
  const { repository, issue, action } = req.body;
  
  if (!repository || !issue || action !== 'opened') {
    return res.status(200).json({ status: 'ignored' });
  }

  // Additional safety: reject if issue body is extremely large
  if (issue.body && issue.body.length > 1024 * 1024) { // 1MB body limit
    logger.warn(`Issue body too large: ${(issue.body.length / 1024).toFixed(2)}KB`);
    return res.status(413).json({ 
      error: 'Issue body too large', 
      size_kb: (issue.body.length / 1024).toFixed(2),
      max_kb: '1024.00'
    });
  }

  // Note: Signature verification happens after body parsing and validation
  // Express already enforces 10MB limit, protecting against resource exhaustion
  if (!verifySignature(req.body, signature)) {
    logger.warn('Invalid signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;
  const cacheKey = `${owner}/${repo}#${issueNumber}`;

  if (processedCache.has(cacheKey)) {
    return res.status(200).json({ status: 'already processed' });
  }

  logger.info(`Processing #${issueNumber} in ${owner}/${repo}`);

  try {
    const suggestions = await analyzeIssue(issue.title, issue.body);

    if (suggestions.label !== 'triage') {
      await octokit.rest.issues.addLabels({
        owner, repo, issue_number: issueNumber,
        labels: [suggestions.label]
      });
    }

    let comment = suggestions.draft;
    if (suggestions.dupe !== 'None') comment += `\n\n🔗 Possible duplicate: ${suggestions.dupe}`;
    comment += '\n\n---\n*Powered by Issue Whisperer*';

    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber, body: comment
    });

    processedCache.add(cacheKey);
    const latency = Date.now() - startTime;
    logger.info(`Done #${issueNumber} in ${latency}ms | Label: ${suggestions.label}`);

    if (bot && CONFIG.channelId) {
      bot.sendMessage(CONFIG.channelId, `🎫 #${issueNumber} triaged | ${suggestions.label} | ${latency}ms`).catch(() => {});
    }

    res.json({ status: 'processed', label: suggestions.label, latency_ms: latency });
  } catch (err) {
    logger.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Polling fallback (every 5 mins)
cron.schedule('*/5 * * * *', async () => {
  logger.info('Polling for new issues...');
  try {
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner: CONFIG.defaultOwner,
      repo: CONFIG.defaultRepo,
      state: 'open',
      since: new Date(Date.now() - 6 * 60 * 1000).toISOString()
    });

    for (const issue of issues) {
      if (issue.pull_request) continue;
      const cacheKey = `${CONFIG.defaultOwner}/${CONFIG.defaultRepo}#${issue.number}`;
      if (processedCache.has(cacheKey)) continue;

      // Skip issues with extremely large bodies to prevent OOM
      if (issue.body && issue.body.length > 1024 * 1024) {
        logger.warn(`Skipping issue #${issue.number}: body too large (${(issue.body.length / 1024).toFixed(2)}KB)`);
        processedCache.add(cacheKey);
        continue;
      }

      const suggestions = await analyzeIssue(issue.title, issue.body);
      
      if (suggestions.label !== 'triage') {
        await octokit.rest.issues.addLabels({
          owner: CONFIG.defaultOwner, repo: CONFIG.defaultRepo,
          issue_number: issue.number, labels: [suggestions.label]
        });
      }

      let comment = suggestions.draft + '\n\n---\n*Powered by Issue Whisperer*';
      await octokit.rest.issues.createComment({
        owner: CONFIG.defaultOwner, repo: CONFIG.defaultRepo,
        issue_number: issue.number, body: comment
      });

      processedCache.add(cacheKey);
      logger.info(`Polled #${issue.number} | ${suggestions.label}`);
    }
  } catch (err) {
    logger.error('Polling error:', err.message);
  }
});

// Start
app.listen(CONFIG.port, () => {
  logger.info(`Issue Whisperer running on port ${CONFIG.port}`);
  logger.info(`Target: ${CONFIG.defaultOwner}/${CONFIG.defaultRepo}`);
});
