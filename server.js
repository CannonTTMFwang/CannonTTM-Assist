const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const SYNC_SECRET = process.env.SYNC_SECRET || 'hg-sync-2026';

if (!API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

// ── In-memory data store — seeded from Claude.ai project syncs ─────────────
let STORE = {
  emails:    [],   // [{id,conversationId,subject,sender,senderName,senderEmail,receivedDateTime,isRead,hasAttachments,importance,summary,webLink}]
  slack:     [],   // [{type,senderName,channelName,channelId,text,ts,unread}]
  syncedAt:  null, // ISO timestamp of last successful sync
  syncCount: 0,
};

// ── MCP server map ─────────────────────────────────────────────────────────
const MCP_SERVERS = {
  outlook:  { type:'url', url:'https://microsoft365.mcp.claude.com/mcp', name:'m365' },
  gmail:    { type:'url', url:'https://gmail.mcp.claude.com/mcp',        name:'gmail' },
  slack:    { type:'url', url:'https://mcp.slack.com/mcp',               name:'slack' },
  calendar: { type:'url', url:'https://gcal.mcp.claude.com/mcp',         name:'gcal' },
  dropbox:  { type:'url', url:'https://mcp.dropbox.com/mcp',             name:'dropbox' },
  notion:   { type:'url', url:'https://mcp.notion.com/mcp',              name:'notion' },
};

// ── Helpers ────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function proxyAnthropic(body, res) {
  const str = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str),
      'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04',
    },
  }, apiRes => {
    res.writeHead(apiRes.statusCode, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' });
    apiRes.pipe(res);
  });
  req.on('error', e => {
    if (!res.headersSent) json(res, 500, { error:{ message:'Proxy error: '+e.message } });
  });
  req.write(str); req.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// ── Server ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url, true);
  setCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Static app
  if (req.method === 'GET' && (pathname === '/' || pathname === '/app')) {
    const p = path.join(__dirname, 'public', 'app.html');
    if (fs.existsSync(p)) { res.writeHead(200,{'Content-Type':'text/html'}); fs.createReadStream(p).pipe(res); }
    else { res.writeHead(404); res.end('app.html not found'); }
    return;
  }

  // Health — shows sync status
  if (req.method === 'GET' && pathname === '/health') {
    json(res, 200, {
      status: 'ok',
      emails: STORE.emails.length,
      slack:  STORE.slack.length,
      syncedAt: STORE.syncedAt,
      syncCount: STORE.syncCount,
    });
    return;
  }

  // ── POST /api/sync — receives data pushed from Claude.ai session ──────────
  if (req.method === 'POST' && pathname === '/api/sync') {
    const secret = req.headers['x-sync-secret'];
    if (secret !== SYNC_SECRET) { json(res, 401, { error:'bad secret' }); return; }
    try {
      const body = JSON.parse(await readBody(req));
      if (body.emails && Array.isArray(body.emails)) STORE.emails = body.emails;
      if (body.slack  && Array.isArray(body.slack))  STORE.slack  = body.slack;
      STORE.syncedAt = new Date().toISOString();
      STORE.syncCount++;
      console.log(`[sync #${STORE.syncCount}] ${STORE.emails.length} emails, ${STORE.slack.length} slack msgs`);
      json(res, 200, { ok:true, emails:STORE.emails.length, slack:STORE.slack.length, syncedAt:STORE.syncedAt });
    } catch(e) { json(res, 400, { error:e.message }); }
    return;
  }

  // ── GET /api/inbox — returns stored email data ────────────────────────────
  if (req.method === 'GET' && pathname === '/api/inbox') {
    json(res, 200, { emails:STORE.emails, syncedAt:STORE.syncedAt, total:STORE.emails.length });
    return;
  }

  // ── GET /api/slack-feed — returns stored Slack data ──────────────────────
  if (req.method === 'GET' && pathname === '/api/slack-feed') {
    json(res, 200, { messages:STORE.slack, syncedAt:STORE.syncedAt, total:STORE.slack.length });
    return;
  }

  // ── POST /api/claude — Anthropic proxy (for AI chat, Notion scan, etc) ───
  if (req.method === 'POST' && pathname === '/api/claude') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const connectors = parsed._connectors || [];
      delete parsed._connectors;
      if (connectors.length) parsed.mcp_servers = connectors.filter(c=>MCP_SERVERS[c]).map(c=>MCP_SERVERS[c]);
      parsed.model = 'claude-sonnet-4-20250514';
      proxyAnthropic(parsed, res);
    } catch(e) { json(res, 400, { error:{ message:'Invalid request: '+e.message } }); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hollywood Galaxy Command Center on port ${PORT}`);
  console.log(`SYNC_SECRET: ${SYNC_SECRET.slice(0,4)}****`);
});
