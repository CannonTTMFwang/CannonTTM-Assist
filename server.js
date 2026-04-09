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

  // Serve static files from /public
  if (req.method === 'GET' && pathname !== '/api/claude') {
    const filePath = pathname === '/'
      ? path.join(__dirname, 'public', 'app.html')
      : path.join(__dirname, 'public', pathname);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      const mimeTypes = {
        '.html': 'text/html',
        '.js':   'application/javascript',
        '.css':  'text/css',
        '.json': 'application/json',
        '.png':  'image/png',
        '.ico':  'image/x-icon',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      res.end(data);
    });
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
        parsed.max_tokens = parsed.max_tokens || 8192;  // ← FIX: required by Anthropic API

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

server.listen(PORT, () => {
  console.log(`Hollywood Galaxy Command Center running on port ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${API_KEY ? '✓ set' : '✗ MISSING'}`);
});
