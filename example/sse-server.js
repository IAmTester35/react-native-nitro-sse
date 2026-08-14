const http = require('http');
const url = require('url');

const PORT = 33333;

/**
 * SSE Test Server with support for various scenarios:
 * - /events: Standard SSE stream
 * - /events?status=204: Test 'No Content' handling
 * - /events?status=429&retry=5: Test 'Too Many Requests' with 'Retry-After'
 * - /events?retry=5000: Send 'retry: 5000' in the stream
 * - Supports both GET and POST
 */
let lastSeenAuthKey = null;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;

  console.log(
    `[${new Date().toLocaleTimeString()}] Request: ${req.method} ${
      parsedUrl.pathname
    }`
  );

  if (parsedUrl.pathname === '/retry-after') {
    const retryAfter = query.retry || '5';
    console.log(`Sending 429 with Retry-After: ${retryAfter}s`);
    res.writeHead(429, {
      'Retry-After': retryAfter,
      'Access-Control-Allow-Origin': '*',
    });
    res.end('Error 429');
    return;
  }

  if (parsedUrl.pathname === '/events') {
    // 1. Handle custom status codes from query params
    const requestedStatus = parseInt(query.status) || 200;

    const authHeader = req.headers.authorization;
    if (authHeader) {
      if (lastSeenAuthKey && lastSeenAuthKey !== authHeader) {
        console.log(
          `\n🔄 [TOKEN UPDATED] ${lastSeenAuthKey} => ${authHeader}\n`
        );
      } else if (!lastSeenAuthKey) {
        console.log(`\n🔑 [INITIAL TOKEN] ${authHeader}\n`);
      }
      lastSeenAuthKey = authHeader;
    }

    // Check for auth if requested (Commented out validation so the random keys don't get rejected)
    if (query.auth === 'true') {
      if (!authHeader) {
        console.log('Unauthorized: Missing Authorization header');
        res.writeHead(401, { 'Access-Control-Allow-Origin': '*' });
        res.end('Unauthorized');
        return;
      }
    }

    if (requestedStatus === 204) {
      console.log('Sending 204 No Content');
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestedStatus === 429 || requestedStatus === 503) {
      const retryAfter = query.retry || '5';
      console.log(
        `Sending ${requestedStatus} with Retry-After: ${retryAfter}s`
      );
      res.writeHead(requestedStatus, {
        'Retry-After': retryAfter,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(`Error ${requestedStatus}`);
      return;
    }

    if (requestedStatus >= 400) {
      console.log(`Sending Error Status: ${requestedStatus}`);
      res.writeHead(requestedStatus, { 'Access-Control-Allow-Origin': '*' });
      res.end(`Error ${requestedStatus}`);
      return;
    }

    // 2. Handle POST body logging
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        console.log('POST Body received:', body);
      });
    }

    // 3. SSE Implementation
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial retry if provided
    if (query.retry) {
      res.write(`retry: ${query.retry}\n\n`);
    } else {
      res.write('retry: 3000\n\n');
    }

    res.write('event: open\ndata: {"status": "connected"}\n\n');

    let count = 0;
    const interval = setInterval(() => {
      count++;

      // Every 3 events, send a heartbeat comment
      if (count % 3 === 0) {
        console.log('Sending heartbeat comment');
        res.write(': heartbeat\n\n');
      }

      const data = JSON.stringify({
        message: `Event #${count}`,
        method: req.method,
        timestamp: new Date().toISOString(),
      });

      console.log(`Sending event #${count}`);
      res.write(`id: ${count}\n`);
      res.write(`event: message\n`);
      res.write(`data: ${data}\n\n`);

      // Auto-close after 20 events to test reconnection
      if (count >= 20) {
        console.log('Reached 20 events, closing connection early');
        clearInterval(interval);
        res.end();
      }
    }, 2000);

    req.on('close', () => {
      console.log('Client disconnected');
      clearInterval(interval);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(
    `\n🚀 SSE Test Server running at http://localhost:${PORT}/events`
  );
  console.log('-------------------------------------------------------');
  console.log('Test Scenarios:');
  console.log(`1. Normal:       http://localhost:${PORT}/events`);
  console.log(`2. No Content:   http://localhost:${PORT}/events?status=204`);
  console.log(
    `3. Rate Limit:   http://localhost:${PORT}/events?status=429&retry=10`
  );
  console.log(`4. Custom Retry: http://localhost:${PORT}/events?retry=1000`);
  console.log('-------------------------------------------------------\n');
});
