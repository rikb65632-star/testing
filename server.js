/**
 * Biomax N-E90 Pro — HTTP Real-Time Log Server
 * 
 * We discovered the device pushes data using HTTP POST requests mapping to 
 * /hdata.aspx or similar, sending JSON wrapped in HTTP.
 * 
 * Example header:
 *   POST /hdata.aspx HTTP/1.0
 *   request_code: receive_cmd
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT    = process.env.TCP_PORT || process.env.PORT || 7005;
const LOG_DIR = process.env.LOG_DIR  || path.join(__dirname, 'logs');

// ── Ensure log directory exists ─────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function today()     { return new Date().toISOString().slice(0, 10); }
function timestamp() { return new Date().toISOString(); }

function appendRawLog(text) {
  const file = path.join(LOG_DIR, `${today()}.log`);
  fs.appendFileSync(file, text + '\n', 'utf8');
}

function appendAttendanceLog(record) {
  const file = path.join(LOG_DIR, `attendance-${today()}.json`);
  let records = [];
  if (fs.existsSync(file)) {
    try { records = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }
  records.push(record);
  fs.writeFileSync(file, JSON.stringify(records, null, 2), 'utf8');
}

function formatIoTime(t) {
  if (!t || t.length < 14) return t || '';
  return `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)} ` +
         `${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}`;
}

const VERIFY_MODE = {
  '1': 'Fingerprint', '2': 'Password', '3': 'Card',
  '4': 'FP+Password', '5': 'FP+Card',  '6': 'Password+FP',
  '7': 'Card+FP',     '20': 'Face',     '21': 'Face+Card',
  '22': 'Face+Pass',  '23': 'Card+Face','24': 'Pass+Face',
};

// ── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const remoteAddr = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

  // 1. Browser health check
  if (req.method === 'GET') {
    const logCount = fs.existsSync(LOG_DIR) 
      ? fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.json')).length 
      : 0;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><head><title>Biomax Server (HTTP)</title>
      <style>body{font-family:monospace;background:#111;color:#0f0;padding:2rem;}</style></head>
      <body>
        <h2>✅ Biomax N-E90 Pro Server — Running</h2>
        <p>Receiving logs on HTTP port <b>${PORT}</b></p>
        <p>Parsed attendance logs: <b>${logCount}</b> file(s)</p>
        <p>Time: ${timestamp()}</p>
      </body></html>
    `);
    return;
  }

  // 2. Handle POST from Biomax device
  let body = Buffer.alloc(0);
  req.on('data', chunk => {
    body = Buffer.concat([body, chunk]);
  });

  req.on('end', () => {
    const bodyStr = body.toString('utf8');
    
    // Log raw physical bytes received
    const rawEntry = [
      `[${timestamp()}] POST ${req.url} FROM: ${remoteAddr}`,
      `Headers: ${JSON.stringify(req.headers)}`,
      `Body [${body.length}b]: ${bodyStr.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`,
      '─'.repeat(60)
    ].join('\n');
    appendRawLog(rawEntry);
    
    console.log(`[${timestamp()}] 📥 ${req.method} ${req.url} from ${remoteAddr}`);

    // Extract one or multiple JSON objects (in case device batches logs together `{...}{...}`)
    let logId = '';
    const jsonChunks = [];
    let depth = 0, startIndex = -1;
    
    for (let i = 0; i < bodyStr.length; i++) {
      if (bodyStr[i] === '{') {
        if (depth === 0) startIndex = i;
        depth++;
      } else if (bodyStr[i] === '}') {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          jsonChunks.push(bodyStr.substring(startIndex, i + 1));
          startIndex = -1;
        }
      }
    }

    // Parse all extracted chunks
    for (const jsonStr of jsonChunks) {
      try {
        const data = JSON.parse(jsonStr);
        if (data.log_id) logId = data.log_id; // save last seen logId for ACK
        
        if (data.fk_info) {
           console.log(`  📊 Device Info Ping: ${data.fk_info.user_count} users, ${data.fk_info.fp_count} fingerprints`);
        }
        
        if (data.user_id && data.io_time) {
          const record = {
            receivedAt : timestamp(),
            serialNo   : data.SerialNo     || '',
            userId     : data.user_id,
            deviceId   : data.fk_device_id || '',
            verifyMode : VERIFY_MODE[data.verify_mode] || data.verify_mode || '',
            ioMode     : data.io_mode      || '',
            punchTime  : formatIoTime(data.io_time),
            logId      : data.log_id || '',
            remoteAddr,
          };
          appendAttendanceLog(record);
          console.log(`  🌟 SAVED | User: ${record.userId} | Time: ${record.punchTime} | Mode: ${record.verifyMode}`);
        }
      } catch (err) {
        console.log(`  ⚠ Parse error on chunk: ${err.message}`);
      }
    }

    // The device uses cmd_id or log_id in the headers to keep track of retries.
    let headerLogId = req.headers['log_id'] || req.headers['cmd_id'] || '';

    // Send the standard ADMS ACK
    const ackJson = JSON.stringify({ log_id: logId || headerLogId || "", result: "OK" });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(ackJson)
    });
    
    // Send the payload to the device
    res.write(ackJson);
    console.log(`  ↩ ACK Sent: ${ackJson}`);
    
    // 🔥 CRITICAL FIX: DO NOT HANG UP IMMEDIATELY 🔥
    // The embedded device is slow. If we close the socket instantly, the device 
    // clears its receive buffer before it finishes saving to its internal flash memory.
    // It drops the ACK and violently retries 2 seconds later.
    // We give it 2.5 seconds to digest the ACK before we hang up.
    setTimeout(() => {
      res.end();
    }, 2500);
  });
});

server.on('error', (err) => console.error(`[${timestamp()}] FATAL: ${err.message}`));

server.listen(PORT, '0.0.0.0', () => {
  console.log('─'.repeat(55));
  console.log(`  Biomax HTTP Server`);
  console.log(`  Port      : ${PORT}`);
  console.log(`  Log dir   : ${LOG_DIR}`);
  console.log(`  Started   : ${timestamp()}`);
  console.log('─'.repeat(55));
});
