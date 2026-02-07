const http = require('http');

const PORT = 33333;

const server = http.createServer((req, res) => {
  console.log(
    `[${new Date().toLocaleTimeString()}] Request: ${req.method} ${req.url}`
  );

  if (req.url === '/events') {
    // SSE Headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write('retry: 10000\n\n');
    res.write('event: open\ndata: {"status": "connected"}\n\n');

    let count = 0;
    const interval = setInterval(() => {
      count++;
      const data = JSON.stringify({
        message: `Hello from Server! Event #${count}`,
        timestamp: new Date().toISOString(),
      });

      console.log(`Sending event #${count}`);
      res.write(`id: ${count}\n`);
      res.write(`event: message\n`);
      res.write(`data: ${data}\n\n`);
    }, 2000);

    req.on('close', () => {
      console.log('Client disconnected');
      clearInterval(interval);
      res.end();
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`SSE Test Server running at http://localhost:${PORT}/events`);
  console.log('Press Ctrl+C to stop.');
});
