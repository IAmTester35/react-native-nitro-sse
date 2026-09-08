import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3100;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, '../benchmark-results');
const ROOT_PKG_PATH = path.resolve(__dirname, '../../package.json');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Formats numbers with thousand separators
const fmt = (n) =>
  typeof n === 'number' ? n.toLocaleString('en-US') : n ?? '-';

const sendJson = (res, statusCode, data) => {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(data));
};

function getLibraryVersion(report) {
  if (report?.libraryVersion) {
    return report.libraryVersion;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG_PATH, 'utf8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function saveBenchmarkReport(report) {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    const version = getLibraryVersion(report);
    const platform = (report.platform || 'unknown').toLowerCase();
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);

    const baseName = `${timestamp}-v${version}-${platform}`;
    const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`);

    // Save detailed JSON
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

    console.log(`\n💾 Benchmark results saved successfully:`);
    console.log(`   - JSON: ${jsonPath}`);
  } catch (err) {
    console.error('Failed to save benchmark report to disk:', err);
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );
  const { pathname, searchParams } = parsedUrl;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health / Status check
  if (pathname === '/health' || pathname === '/status') {
    sendJson(res, 200, { status: 'ok', port: PORT, serverTime: Date.now() });
    return;
  }

  // Dashboard preview UI
  if (pathname === '/' || pathname === '/dashboard') {
    const htmlPath = path.join(RESULTS_DIR, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(fs.readFileSync(htmlPath));
      return;
    }
  }

  // API to list and return all saved benchmark JSON reports
  if (pathname === '/api/reports' || pathname === '/reports') {
    try {
      if (!fs.existsSync(RESULTS_DIR)) {
        sendJson(res, 200, []);
        return;
      }
      const files = fs
        .readdirSync(RESULTS_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();

      const reports = files.map((filename) => {
        const fullPath = path.join(RESULTS_DIR, filename);
        const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        return {
          filename,
          data: content,
        };
      });

      sendJson(res, 200, reports);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Receive, display, and save benchmark report
  if (pathname === '/report' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const report = JSON.parse(body);
        const version = getLibraryVersion(report);

        console.log(
          '\n========================================================================================================'
        );
        console.log(
          `🚀 SSE BENCHMARK REPORT [v${version} | Platform: ${
            report.platform || 'Unknown'
          } | Device: ${report.device || 'Simulator'}]`
        );
        console.log(
          '========================================================================================================'
        );

        if (Array.isArray(report.results)) {
          console.table(
            report.results.map((r) => ({
              'Scenario': r.name,
              'Target (ev/s)': fmt(r.targetRate),
              'Actual (ev/s)': fmt(r.throughput),
              'Data (KB/s)': fmt(r.dataRateKBps ?? 0),
              'Delivery %': `${r.deliveryRatePercent ?? 100}%`,
              'Avg Latency': r.latency ? `${r.latency.avgMs} ms` : '-',
              'P95 Latency': r.latency ? `${r.latency.p95Ms} ms` : '-',
              'Batches': fmt(r.totalBatches),
              'Hermes GCs': r.hermesMetrics.gcCountDelta,
              'GC CPU (ms)': fmt(r.hermesMetrics.gcCpuTimeDeltaMs),
              'Alloc Churn (KB)': fmt(
                r.hermesMetrics.totalAllocatedBytesDeltaKB ??
                  r.hermesMetrics.allocatedBytesDeltaKB
              ),
              'Heap (KB)': fmt(r.hermesMetrics.finalHeapSizeKB),
            }))
          );
        } else {
          console.log(JSON.stringify(report, null, 2));
        }
        console.log(
          '========================================================================================================\n'
        );

        // Automatically save to file based on current library version
        saveBenchmarkReport(report);

        sendJson(res, 200, { received: true, version });
      } catch (err) {
        console.error('Error parsing report payload:', err);
        sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // SSE Stress Stream: /sse?rate=1000&size=128&duration=5
  if (pathname === '/sse') {
    const rate = Math.max(1, parseInt(searchParams.get('rate') || '100', 10));
    const payloadSize = Math.max(
      32,
      parseInt(searchParams.get('size') || '128', 10)
    );
    const durationSec = Math.max(
      1,
      parseInt(searchParams.get('duration') || '5', 10)
    );

    console.log(
      `[SSE Server] Client connected -> Rate: ${rate} ev/s, Size: ${payloadSize} B, Duration: ${durationSec}s`
    );

    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const targetTotal = rate * durationSec;
    const padding = 'x'.repeat(Math.max(1, payloadSize - 50));

    // Chunking logic: at high rates (e.g. 10,000/s), node interval < 5ms is inaccurate
    const targetIntervalMs = 1000 / rate;
    const batchPerTick =
      targetIntervalMs < 10 ? Math.ceil(10 / targetIntervalMs) : 1;
    const tickIntervalMs = Math.max(5, targetIntervalMs * batchPerTick);

    let sent = 0;
    const timer = setInterval(() => {
      let buffer = '';
      for (let i = 0; i < batchPerTick && sent < targetTotal; i++) {
        sent++;
        const payload = JSON.stringify({
          id: sent,
          ts: Date.now(),
          pad: padding,
        });
        buffer += `id: ${sent}\nevent: benchmark\ndata: ${payload}\n\n`;
      }

      if (buffer.length > 0) {
        res.write(buffer);
      }

      if (sent >= targetTotal) {
        clearInterval(timer);
        res.write(
          `event: close\ndata: {"status":"finished","total":${sent}}\n\n`
        );
        res.end();
        console.log(
          `[SSE Server] Stream completed: Sent ${sent}/${targetTotal} events.`
        );
      }
    }, tickIntervalMs);

    req.on('close', () => {
      clearInterval(timer);
      console.log(`[SSE Server] Connection closed by client (Sent: ${sent}).`);
    });

    return;
  }

  // Fallback 404
  res.writeHead(404, CORS_HEADERS);
  res.end('Not Found. Endpoints: /sse, /report, /status, /health');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `\n⚡ Nitro-SSE Benchmark Server listening on http://0.0.0.0:${PORT}`
  );
  console.log('   - Endpoint: /sse?rate=100&size=128&duration=5');
  console.log(
    '   - Report:   POST /report (Auto-saves to example/benchmark-results/)'
  );
  console.log(
    '   - Android:  Run "adb reverse tcp:3100 tcp:3100" if connecting via localhost.\n'
  );
});
