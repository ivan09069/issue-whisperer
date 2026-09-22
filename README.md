# Issue Whisperer

GitHub issue triage. A local classifier runs with no key. Groq drafts the comment when `GROQ_API_KEY` is set.

## Quick Start

### Offline pass

```bash
python analyze_issue.py "login times out" "token refresh throws"
```

Python standard library only. No `requirements.txt`.

### Server

From a licensed checkout:

1. `npm install`
2. Copy `.env.example` to `.env`
3. `npm test`
4. `npm start`

Railway: connect the checkout, set the variables in `.env.example`, deploy. The license does not grant a fork.

### GitHub Webhook Setup
1. Go to your repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://your-app.railway.app/webhook`
3. Content type: `application/json`
4. Secret: Your `GITHUB_WEBHOOK_SECRET`
5. Events: Select "Issues"

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with repo access |
| `GROQ_API_KEY` | Yes, for model comments | Groq key. The offline classifier does not use it. |
| `GITHUB_WEBHOOK_SECRET` | No | Webhook signature secret |
| `REDIS_URL` | No | Redis for caching |
| `STRIPE_SECRET_KEY` | No | Pro tier gating |
| `TELEGRAM_TOKEN` | No | Telegram bot alerts |
| `CHANNEL_ID` | No | Telegram channel |

## How It Works

1. **Webhook receives** new issue event
2. **Groq analyzes** title and body when `GROQ_API_KEY` is set
3. **Labels applied** (bug/enhancement/question/docs)
4. **Draft response** posted as comment
5. **Duplicates flagged** if detected

## Endpoints

- `GET /health` - Health check
- `POST /webhook` - GitHub webhook handler

## Local Development

```bash
npm install
npm test
npm start
```

## License

Copyright (c) 2026 EchoForge Studios. All rights reserved.
No use or copy is permitted without a written license. See [LICENSE](LICENSE).
Built by [EchoForge Studios](https://github.com/ivan09069).

## Security configuration

`GITHUB_WEBHOOK_SECRET` is required for webhook processing. Missing configuration
returns 503; missing or invalid signatures return 401 before AI/provider requests.
`GITHUB_ALLOWED_REPOS` is a comma-separated allowlist; it defaults to
`DEFAULT_OWNER/DEFAULT_REPO`. Only signed `issues` events for enabled repositories
are processed. Concurrent duplicate deliveries within one process are rejected.
Multiple replicas still require a shared durable work queue before scale-up.

Background polling is off unless `ENABLE_POLLING=true`. The optional Telegram
helper now uses the existing configured integration. Tests use fake providers and
never contact GitHub, Groq, Stripe, Redis, or Telegram.

```sh
node --test security.test.js
```
