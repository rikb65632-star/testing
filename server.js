/**
 * Biomax N-E90 Pro — TCP Real-Time Log Server
 *
 * Protocol : Raw TCP (Biomax FKRealSvrOcxTcp SDK)
 * Port     : TCP_PORT env var (default 7005)
 *
 * Device sends JSON:
 *   { "log_id", "user_id", "fk_device_id", "verify_mode",
 *     "io_mode", "io_time" (YYYYMMDDHHmmss), "SerialNo" }
 *
 * Server responds with:
 *   { "log_id": "...", "result": "OK", "mode": "nothing" }
 *
 * Logs saved to:
 *   ./logs/YYYY-MM-DD.log              — raw data from every connection
 *   ./logs/attendance-YYYY-MM-DD.json  — parsed attendance records
 */

const net  = require('net');
const fs   = require('fs');
const path = require('path');

const TCP_PORT = process.env.TCP_PORT || process.env.PORT || 7005;
const LOG_DIR  = process.env.LOG_DIR  || path.join(__dirname, 'logs');

// ── Ensure log directory exists ─────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────────────
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

/** Convert Biomax io_time "YYYYMMDDHHmmss" → "YYYY-MM-DD HH:mm:ss" */
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

// ── TCP Server ───────────────────────────────────────────────────────────────
const server = net.createServer((socket) => {
  const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[${timestamp()}] ✅ Device connected from ${remoteAddr}`);

  let buffer = '';

  socket.on('data', (chunk) => {
    // ---- ADDED: Log ALL raw bytes as string and hex immediately ----
    const rawString = chunk.toString();
    const hexString = chunk.toString('hex');
    console.log(`[${timestamp()}] 🔍 RAW RECEIVE [${chunk.length} bytes]:`);
    console.log(`  STR: ${rawString.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
    // console.log(`  HEX: ${hexString}`); // Uncomment if we need binary debugging
    appendRawLog(`[${timestamp()}] RAW [${chunk.length}b]: ${rawString}`);
    // ----------------------------------------------------------------

    buffer += rawString;

    let start = buffer.indexOf('{');
    while (start !== -1) {
      let depth = 0, end = -1;
      for (let i = start; i < buffer.length; i++) {
        if (buffer[i] === '{') depth++;
        if (buffer[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) break;

      const raw = buffer.slice(start, end + 1);
      buffer = buffer.slice(end + 1);
      start = buffer.indexOf('{');

      // Raw log
      appendRawLog([
        `[${timestamp()}] FROM: ${remoteAddr}`,
        `RAW: ${raw}`,
        '─'.repeat(60),
      ].join('\n'));
      console.log(`[${timestamp()}] 📥 ${remoteAddr}: ${raw.slice(0, 120)}`);

      try {
        const data    = JSON.parse(raw);
        const logId   = data.log_id       || '';
        const userId  = data.user_id      || '';

        const record = {
          receivedAt : timestamp(),
          serialNo   : data.SerialNo     || '',
          userId,
          deviceId   : data.fk_device_id || '',
          verifyMode : VERIFY_MODE[data.verify_mode] || data.verify_mode || '',
          ioMode     : data.io_mode      || '',
          punchTime  : formatIoTime(data.io_time || ''),
          logId,
          remoteAddr,
        };
        appendAttendanceLog(record);
        console.log(`  ✓ Saved | User: ${userId} | Time: ${record.punchTime} | Mode: ${record.verifyMode}`);

        // ACK
        const ack = JSON.stringify({ log_id: logId, result: 'OK', mode: 'nothing' });
        socket.write(ack);
        console.log(`  ↩ ACK: ${ack}`);

      } catch (err) {
        console.log(`  ⚠ Parse error: ${err.message}`);
        appendRawLog(`[PARSE-ERR ${timestamp()}] ${err.message}\n${raw}`);
      }
    }
  });

  socket.on('end',   () => console.log(`[${timestamp()}] 🔌 Disconnected: ${remoteAddr}`));
  socket.on('error', (e) => console.log(`[${timestamp()}] ❌ Error (${remoteAddr}): ${e.message}`));
});

server.on('error', (err) => console.error(`[${timestamp()}] FATAL: ${err.message}`));

server.listen(TCP_PORT, '0.0.0.0', () => {
  console.log('─'.repeat(55));
  console.log(`  Biomax N-E90 Pro TCP Log Server`);
  console.log(`  TCP Port  : ${TCP_PORT}`);
  console.log(`  Log dir   : ${LOG_DIR}`);
  console.log(`  Started   : ${timestamp()}`);
  console.log('─'.repeat(55));
});
