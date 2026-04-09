const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── PORT: Render sets process.env.PORT automatically. Never hardcode this. ──
const PORT = process.env.PORT || 3001;

// ── API KEY: Set this in Render → Environment Variables as ANTHROPIC_API_KEY ─
// For local use, you can also hardcode it here temporarily:
// const API_KEY = 'sk-ant-api03-your-key-here';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set.');
  console.error('On Render: go to your service → Environment → Add Environment Variable');
  console.error('Key: ANTHROPIC_API_KEY  Value: your key from console.anthropic.com');
  process.exit(1);
}

const MCP_SERVERS = {
  outlook:  { type: 'url', url: 'https://microsoft365.mcp.claude.com/mcp', name: 'm365' },
  gmail:    { type: 'url', url: 'https://gmail.mcp.claude.com/mcp',        name: 'gmail' },
  slack:    { type: 'url', url: 'https://mcp.slack.com/mcp',               name: 'slack' },
  calendar: { type: 'url', url: 'https://gcal.mcp.claude.com/mcp',         name: 'gcal' },
  dropbox:  { type: 'url', url: 'https://mcp.dropbox.com/mcp',             name: 'dropbox' },
};

function proxyAnthropicRequest(body, res) {
  const bodyStr = JSON.stringify(body);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04',
    },
  };

  const apiReq = https.request(options, (apiRes) => {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    apiRes.pipe(res);
  });

  apiReq.on('error', (err) => {
    console.error('Anthropic API error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }));
    }
  });

  apiReq.write(bodyStr);
  apiReq.end();
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url, true).pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Serve the app HTML
  if (req.method === 'GET' && (pathname === '/' || pathname === '/app')) {
    const htmlPath = path.join(__dirname, 'public', 'app.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2>app.html not found in /public</h2><p>Make sure public/app.html exists in your repo.</p>');
    }
    return;
  }

  // Health check — Render pings this to confirm the service is alive
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status: 'ok', service: 'Hollywood Galaxy Command Center' }));
    return;
  }

  // Claude API proxy — the app calls this for all AI requests
  if (req.method === 'POST' && pathname === '/api/claude') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const connectors = parsed._connectors || [];
        delete parsed._connectors;
        if (connectors.length > 0) {
          parsed.mcp_servers = connectors
            .filter(c => MCP_SERVERS[c])
            .map(c => MCP_SERVERS[c]);
        }
        parsed.model = 'claude-sonnet-4-20250514';
        proxyAnthropicRequest(parsed, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: 'Invalid request: ' + e.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── CRITICAL: must bind to 0.0.0.0 on Render, not 127.0.0.1 ─────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hollywood Galaxy Command Center running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`API key loaded: ${API_KEY.slice(0,12)}...`);
});
