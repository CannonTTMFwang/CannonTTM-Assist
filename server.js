const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Microsoft 365 OAuth Config ─────────────────────────────────────────────
const AZURE_CLIENT_ID     = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_TENANT_ID     = process.env.AZURE_TENANT_ID;
const BASE_URL            = process.env.BASE_URL || `https://cannonttm-assist.onrender.com`;
const REDIRECT_URI        = `${BASE_URL}/auth/callback`;

// Token store — persisted in memory, survives restarts via env var fallback
let msTokens = {
  access_token:  process.env.MS_ACCESS_TOKEN  || null,
  refresh_token: process.env.MS_REFRESH_TOKEN || null,
  expires_at:    parseInt(process.env.MS_TOKEN_EXPIRES || '0'),
};

if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }

// ── Microsoft Graph helpers ────────────────────────────────────────────────

function msRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function refreshAccessToken() {
  if (!msTokens.refresh_token) throw new Error('No refresh token — visit /auth/login first');
  const params = new URLSearchParams({
    client_id:     AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: msTokens.refresh_token,
    scope:         'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access',
  });
  const body = params.toString();
  const result = await msRequest({
    hostname: 'login.microsoftonline.com',
    path:     `/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (result.body.access_token) {
    msTokens.access_token  = result.body.access_token;
    msTokens.refresh_token = result.body.refresh_token || msTokens.refresh_token;
    msTokens.expires_at    = Date.now() + (result.body.expires_in * 1000) - 60000;
    console.log('✓ MS token refreshed, expires in', result.body.expires_in, 's');
    return msTokens.access_token;
  }
  throw new Error('Token refresh failed: ' + JSON.stringify(result.body));
}

async function getValidAccessToken() {
  if (msTokens.access_token && Date.now() < msTokens.expires_at) {
    return msTokens.access_token;
  }
  return await refreshAccessToken();
}

async function graphRequest(endpoint, method = 'GET', body = null) {
  const token = await getValidAccessToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
  const result = await msRequest({
    hostname: 'graph.microsoft.com',
    path:     `/v1.0${endpoint}`,
    method,
    headers,
  }, body ? JSON.stringify(body) : null);
  return result;
}

// ── Anthropic proxy helpers ────────────────────────────────────────────────

const MCP_SERVERS = {
  outlook:  { type: 'url', url: 'https://microsoft365.mcp.claude.com/mcp', name: 'm365' },
  gmail:    { type: 'url', url: 'https://gmail.mcp.claude.com/mcp',        name: 'gmail' },
  slack:    { type: 'url', url: 'https://mcp.slack.com/mcp',               name: 'slack' },
  calendar: { type: 'url', url: 'https://gcal.mcp.claude.com/mcp',         name: 'gcal' },
  dropbox:  { type: 'url', url: 'https://mcp.dropbox.com/mcp',             name: 'dropbox' },
  notion:   { type: 'url', url: 'https://mcp.notion.com/mcp',              name: 'notion' },
};

function proxyAnthropicRequest(body, res) {
  const bodyStr = JSON.stringify(body);
  const options = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers:  {
      'Content-Type':    'application/json',
      'Content-Length':  Buffer.byteLength(bodyStr),
      'x-api-key':       API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'mcp-client-2025-04-04',
    },
  };
  const apiReq = https.request(options, apiRes => {
    res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    apiRes.pipe(res);
  });
  apiReq.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }));
    }
  });
  apiReq.write(bodyStr);
  apiReq.end();
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static app ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && (pathname === '/' || pathname === '/app')) {
    const htmlPath = path.join(__dirname, 'public', 'app.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(404); res.end('public/app.html not found');
    }
    return;
  }

  // ── Health check ────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:       'ok',
      ms_authed:    !!(msTokens.access_token),
      token_valid:  Date.now() < msTokens.expires_at,
    }));
    return;
  }

  // ── OAuth Step 1: Redirect to Microsoft login ────────────────────────────
  if (req.method === 'GET' && pathname === '/auth/login') {
    const authUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/authorize?` +
      new URLSearchParams({
        client_id:     AZURE_CLIENT_ID,
        response_type: 'code',
        redirect_uri:  REDIRECT_URI,
        scope:         'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access User.Read',
        response_mode: 'query',
        prompt:        'consent',
      });
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── OAuth Step 2: Handle callback, exchange code for tokens ─────────────
  if (req.method === 'GET' && pathname === '/auth/callback') {
    const { code, error } = parsed.query;
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>Auth error: ${error}</h2><p>${parsed.query.error_description || ''}</p>`);
      return;
    }
    if (!code) {
      res.writeHead(400); res.end('Missing code');
      return;
    }
    try {
      const params = new URLSearchParams({
        client_id:     AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        scope:         'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access User.Read',
      });
      const body = params.toString();
      const result = await msRequest({
        hostname: 'login.microsoftonline.com',
        path:     `/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, body);

      if (result.body.access_token) {
        msTokens.access_token  = result.body.access_token;
        msTokens.refresh_token = result.body.refresh_token;
        msTokens.expires_at    = Date.now() + (result.body.expires_in * 1000) - 60000;
        console.log('✓ Microsoft OAuth complete — tokens stored');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><style>
          body{font-family:sans-serif;background:#08080a;color:#ede9e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
          .box{background:#141418;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:40px;text-align:center;max-width:400px;}
          h2{color:#4db87a;margin-bottom:12px;} p{color:#9d9aa4;margin-bottom:20px;}
          a{display:inline-block;padding:10px 24px;background:#d4a843;color:#08080a;border-radius:6px;text-decoration:none;font-weight:600;}
        </style></head><body><div class="box">
          <h2>✓ Connected to Microsoft 365</h2>
          <p>Your Outlook email is now live in the Command Center. Tokens saved — you won't need to do this again.</p>
          <a href="/">Open Command Center</a>
        </div></body></html>`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Token exchange failed</h2><pre>${JSON.stringify(result.body, null, 2)}</pre>`);
      }
    } catch(e) {
      res.writeHead(500); res.end('Auth error: ' + e.message);
    }
    return;
  }

  // ── /api/emails — Live Outlook emails via Microsoft Graph ────────────────
  if (req.method === 'GET' && pathname === '/api/emails') {
    if (!msTokens.access_token && !msTokens.refresh_token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_authenticated', login_url: '/auth/login' }));
      return;
    }
    try {
      const limit  = parseInt(parsed.query.limit || '50');
      const skip   = parseInt(parsed.query.skip  || '0');
      const folder = parsed.query.folder || 'inbox';
      const search = parsed.query.search || '';

      let endpoint = `/me/mailFolders/${folder}/messages?$top=${limit}&$skip=${skip}&$orderby=receivedDateTime desc`;
      endpoint += `&$select=id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,importance,conversationId,bodyPreview,webLink`;
      if (search) endpoint += `&$search="${encodeURIComponent(search)}"`;

      const result = await graphRequest(endpoint);
      if (result.status === 200) {
        const emails = (result.body.value || []).map(m => ({
          id:               m.id,
          conversationId:   m.conversationId,
          subject:          m.subject || '(no subject)',
          sender:           `${m.from?.emailAddress?.name || ''} <${m.from?.emailAddress?.address || ''}>`,
          senderName:       m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown',
          senderEmail:      m.from?.emailAddress?.address || '',
          receivedDateTime: m.receivedDateTime,
          isRead:           m.isRead,
          hasAttachments:   m.hasAttachments,
          importance:       m.importance,
          summary:          m.bodyPreview || '',
          webLink:          m.webLink || '',
        }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ emails, total: emails.length, skip, limit }));
      } else if (result.status === 401) {
        // Token expired — try refresh once
        try {
          await refreshAccessToken();
          res.writeHead(307, { Location: req.url }); res.end();
        } catch(e) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'token_expired', login_url: '/auth/login' }));
        }
      } else {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.body }));
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /api/email/:id — Read a single email body ────────────────────────────
  if (req.method === 'GET' && pathname.startsWith('/api/email/')) {
    const msgId = decodeURIComponent(pathname.slice('/api/email/'.length));
    if (!msTokens.access_token && !msTokens.refresh_token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_authenticated', login_url: '/auth/login' }));
      return;
    }
    try {
      const result = await graphRequest(`/me/messages/${encodeURIComponent(msgId)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,body,bodyPreview,webLink`);
      if (result.status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id:      result.body.id,
          subject: result.body.subject,
          from:    result.body.from?.emailAddress,
          to:      (result.body.toRecipients || []).map(r => r.emailAddress),
          cc:      (result.body.ccRecipients || []).map(r => r.emailAddress),
          date:    result.body.receivedDateTime,
          body:    result.body.body?.content || result.body.bodyPreview || '',
          bodyType: result.body.body?.contentType || 'text',
          webLink: result.body.webLink || '',
        }));
      } else {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.body }));
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /api/auth-status — Check if MS is connected ─────────────────────────
  if (req.method === 'GET' && pathname === '/api/auth-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ms_connected:  !!(msTokens.access_token || msTokens.refresh_token),
      token_valid:   Date.now() < msTokens.expires_at,
      login_url:     '/auth/login',
    }));
    return;
  }

  // ── /api/claude — Anthropic proxy ───────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/claude') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed2 = JSON.parse(body);
        const connectors = parsed2._connectors || [];
        delete parsed2._connectors;
        if (connectors.length > 0) {
          parsed2.mcp_servers = connectors.filter(c => MCP_SERVERS[c]).map(c => MCP_SERVERS[c]);
        }
        parsed2.model = 'claude-sonnet-4-20250514';
        proxyAnthropicRequest(parsed2, res);
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid request: ' + e.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hollywood Galaxy Command Center running on port ${PORT}`);
  console.log(`MS OAuth:   ${AZURE_CLIENT_ID ? '✓ Configured' : '✗ Missing env vars'}`);
  console.log(`MS Tokens:  ${msTokens.access_token ? '✓ Have access token' : msTokens.refresh_token ? '✓ Have refresh token' : '✗ Not authenticated — visit /auth/login'}`);
});
