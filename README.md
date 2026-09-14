# Issue Whisperer 🤖

AI-powered GitHub issue triage using Grok. Automatically labels issues, detects duplicates, and drafts responses.

## Quick Start

### Deploy to Railway (Recommended)
1. Fork this repo
2. Connect to [Railway](https://railway.app)
3. Add environment variables (see `.env.example`)
4. Deploy

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
| `XAI_API_KEY` | Yes | x.ai API key for Grok |
| `GITHUB_WEBHOOK_SECRET` | No | Webhook signature secret |
| `REDIS_URL` | No | Redis for caching |
| `STRIPE_SECRET_KEY` | No | Pro tier gating |
| `TELEGRAM_TOKEN` | No | Telegram bot alerts |
| `CHANNEL_ID` | No | Telegram channel |

## How It Works

1. **Webhook receives** new issue event
2. **Grok analyzes** title and body
3. **Labels applied** (bug/enhancement/question/docs)
4. **Draft response** posted as comment
5. **Duplicates flagged** if detected

## Endpoints

- `GET /health` - Health check
- `POST /webhook` - GitHub webhook handler

## Local Development

```bash
# Install deps
npm install
pip install -r requirements.txt

# Set environment
cp .env.example .env
# Edit .env with your keys

# Run
npm start
```

## License

MIT - Built by [EchoForge Studios](https://github.com/ivan09069)
