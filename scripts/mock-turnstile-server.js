import http from 'node:http';

const port = Number(process.env.TURNSTILE_MOCK_PORT || 3093);

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }

  if (request.method !== 'POST' || request.url !== '/siteverify') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }

  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const token = new URLSearchParams(body).get('response');
    const payload = token === 'success-token'
      ? { success: true }
      : { success: false, 'error-codes': ['invalid-input-response'] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[turnstile-mock] listening on http://127.0.0.1:${port}`);
});
