const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// On Render, PORT is set automatically by the platform
const PORT = process.env.PORT || 3001;

// API key comes from Render's environment variables — never hardcoded
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('Set it in Render Dashboard → Your Service → Environment → Add Environment Variable');
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
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: { message: 'API error: ' + err.message } }));
  });

  apiReq.write(bodyStr);
  apiReq.end();
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

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

  // Serve the main app
  if (req.method === 'GET' && (pathname === '/' || pathname === '/app')) {
    const htmlPath = path.join(__dirname, 'public', 'app.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2>app.html not found in /public folder</h2>');
    }
    return;
  }

  // Health check — Render uses this to confirm the service is up
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Hollywood Galaxy Command Center' }));
    return;
  }

  // Claude API proxy
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hollywood Galaxy Command Center running on port ${PORT}`);
});
