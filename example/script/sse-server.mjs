import http from 'node:http';

const PORT = 33333;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

let lastSeenAuthKey = null;

/**
 * Validates and extracts Retry-After parameter.
 */
function getValidRetryAfter(rawRetry) {
  if (rawRetry === undefined || rawRetry === null) {
    return { valid: true, value: '5' };
  }
  if (typeof rawRetry !== 'string' || Array.isArray(rawRetry)) {
    return { valid: false };
  }
  if (/[\r\n\0\x00-\x1F\x7F]/.test(rawRetry)) {
    return { valid: false };
  }
  const trimmed = rawRetry.trim();
  if (!trimmed) {
    return { valid: false };
  }
  if (/^\d+$/.test(trimmed)) {
    return { valid: true, value: trimmed };
  }
  const parsedDate = Date.parse(trimmed);
  if (!isNaN(parsedDate)) {
    return { valid: true, value: trimmed };
  }
  return { valid: false };
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = parsedUrl;

  console.log(`[${new Date().toLocaleTimeString()}] Request: ${req.method} ${pathname}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Route: /retry-after
  if (pathname === '/retry-after') {
    const rawRetry = searchParams.get('retry');
    const retryValidation = getValidRetryAfter(rawRetry ?? undefined);

    if (!retryValidation.valid) {
      console.log('Invalid Retry-After query parameter. Sending 400 Bad Request.');
      res.writeHead(400, CORS_HEADERS);
      res.end('Bad Request: Invalid retry parameter');
      return;
    }

    const retryAfter = retryValidation.value;
    console.log(`Sending 429 with Retry-After: ${retryAfter}s`);
    res.writeHead(429, {
      ...CORS_HEADERS,
      'Retry-After': retryAfter,
    });
    res.end('Error 429');
    return;
  }

  // Route: /events
  if (pathname === '/events') {
    const requestedStatus = parseInt(searchParams.get('status') || '200', 10);

    const authHeader = req.headers.authorization;
    if (authHeader) {
      if (lastSeenAuthKey && lastSeenAuthKey !== authHeader) {
        console.log(`\n🔄 [TOKEN UPDATED] ${lastSeenAuthKey} => ${authHeader}\n`);
      } else if (!lastSeenAuthKey) {
        console.log(`\n🔑 [INITIAL TOKEN] ${authHeader}\n`);
      }
      lastSeenAuthKey = authHeader;
    }

    // Check auth flag if requested
    if (searchParams.get('auth') === 'true' && !authHeader) {
      console.log('Unauthorized: Missing Authorization header');
      res.writeHead(401, CORS_HEADERS);
      res.end('Unauthorized');
      return;
    }

    if (requestedStatus === 204) {
      console.log('Sending 204 No Content');
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (requestedStatus === 429 || requestedStatus === 503) {
      const rawRetry = searchParams.get('retry');
      const retryValidation = getValidRetryAfter(rawRetry ?? undefined);
      if (!retryValidation.valid) {
        console.log('Invalid Retry-After query parameter. Sending 400 Bad Request.');
        res.writeHead(400, CORS_HEADERS);
        res.end('Bad Request: Invalid retry parameter');
        return;
      }

      const retryAfter = retryValidation.value;
      console.log(`Sending ${requestedStatus} with Retry-After: ${retryAfter}s`);
      res.writeHead(requestedStatus, {
        ...CORS_HEADERS,
        'Retry-After': retryAfter,
      });
      res.end(`Error ${requestedStatus}`);
      return;
    }

    if (requestedStatus >= 400) {
      console.log(`Sending Error Status: ${requestedStatus}`);
      res.writeHead(requestedStatus, CORS_HEADERS);
      res.end(`Error ${requestedStatus}`);
      return;
    }

    // Read POST body if present
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        console.log('POST Body received:', body);
      });
    }

    // SSE Stream headers
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial retry directive
    const customRetry = searchParams.get('retry') || '3000';
    res.write(`retry: ${customRetry}\n\n`);
    res.write('event: open\ndata: {"status": "connected"}\n\n');

    let count = 0;
    const interval = setInterval(() => {
      count++;

      // Every 3 events, send heartbeat comment
      if (count % 3 === 0) {
        console.log('Sending heartbeat comment');
        res.write(': heartbeat\n\n');
      }

      const payload = JSON.stringify({
        message: `Event #${count}`,
        method: req.method,
        timestamp: new Date().toISOString(),
      });

      console.log(`Sending event #${count}`);
      res.write(`id: ${count}\n`);
      res.write('event: message\n');
      res.write(`data: ${payload}\n\n`);

      // Every 2 events, send custom named event
      if (count % 2 === 0) {
        console.log(`Sending custom event (notification) #${count}`);
        res.write(`id: custom-${count}\n`);
        res.write('event: notification\n');
        res.write(
          `data: ${JSON.stringify({
            alert: `Custom alert #${count}`,
            time: new Date().toLocaleTimeString(),
          })}\n\n`
        );
      }

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
    return;
  }

  // Fallback 404
  res.writeHead(404, CORS_HEADERS);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n🚀 SSE Test Server running at http://localhost:${PORT}/events`);
  console.log('-------------------------------------------------------');
  console.log('Test Scenarios:');
  console.log(`1. Normal:       http://localhost:${PORT}/events`);
  console.log(`2. No Content:   http://localhost:${PORT}/events?status=204`);
  console.log(`3. Rate Limit:   http://localhost:${PORT}/events?status=429&retry=10`);
  console.log(`4. Custom Retry: http://localhost:${PORT}/events?retry=1000`);
  console.log('-------------------------------------------------------\n');
});
