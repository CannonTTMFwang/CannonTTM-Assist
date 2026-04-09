# Hollywood Galaxy Command Center

Property management command center for Frank Wang — Hollywood Block LLC, 7021 Hollywood Blvd, Los Angeles CA 90028.

## What it does

- Live action board with all open property management items
- Claude AI chat wired to Outlook, Gmail, Slack, Calendar, and Dropbox
- Inline card action buttons that draft emails, search emails, and pull live data
- Approval system — every write action (email draft, Slack message) requires explicit approval before executing

## Deploying to Render

### 1. Push this repo to GitHub

### 2. Create a new Web Service on Render
- Go to [render.com](https://render.com)
- Click **New → Web Service**
- Connect your GitHub account and select this repository
- Settings:
  - **Environment:** Node
  - **Build Command:** `npm install`
  - **Start Command:** `npm start`
  - **Instance Type:** Free (or Starter for always-on)

### 3. Add your API key as an environment variable
- In your Render service dashboard, go to **Environment**
- Click **Add Environment Variable**
- Key: `ANTHROPIC_API_KEY`
- Value: your Anthropic API key from [console.anthropic.com](https://console.anthropic.com)

### 4. Deploy
Render will build and deploy automatically. Your app will be live at:
`https://your-service-name.onrender.com`

## Project structure

```
├── server.js          # Node.js server — proxies API calls, serves the app
├── public/
│   └── app.html       # Full Command Center UI
├── package.json
├── .gitignore
└── README.md
```

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key from console.anthropic.com |
| `PORT` | Set automatically by Render — do not set manually |

## Connectors

Make sure these are connected in your Claude.ai Settings → Integrations:
- Microsoft 365 (Outlook email + calendar)
- Gmail
- Slack
- Google Calendar
- Dropbox
