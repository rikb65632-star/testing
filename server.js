const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.TCP_PORT || 7005;
const LOG_DIR = process.env.LOG_DIR || './logs';

// Ensure standard log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFile() {
    const dateStr = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `attendance-${dateStr}.json`);
}

function logToConsoleAndFile(message, dataObject = null) {
    const timestamp = new Date().toISOString();
    let logMsg = `[${timestamp}] ${message}`;
    if (dataObject) {
         logMsg += `\n${JSON.stringify(dataObject, null, 2)}`;
    }
    console.log(logMsg);
}

const server = net.createServer((socket) => {
    const clientIP = socket.remoteAddress;

    // 1. THE INVISIBLE HANDSHAKE
    // The exact moment the device connects, we blast the secret 17-byte 
    // binary handshake that we discovered via Wireshark. 
    // This tells the device "I am the official Biomax Windows Software!"
    const handshake = Buffer.from('bb6600a900000000000000000000ca0100', 'hex');
    socket.write(handshake);
    
    // We will accumulate chunks of data perfectly to ensure we never drop a split packet
    let receiveBuffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
        // Accumulate incoming bytes
        receiveBuffer = Buffer.concat([receiveBuffer, chunk]);

        // Look for JSON objects safely. TCP can split packets in half!
        let searchIndex = 0;
        let madeChanges = false;

        // Continuous parsing loop for batched JSONs
        while (true) {
            const start = receiveBuffer.indexOf('{', searchIndex, 'utf8');
            if (start === -1) break;

            const end = receiveBuffer.indexOf('}', start, 'utf8');
            if (end === -1) break;

            const jsonSlice = receiveBuffer.slice(start, end + 1);
            
            try {
                const parsed = JSON.parse(jsonSlice.toString('utf8'));
                
                // --- SUCCESSFUL PARSE! ---
                const logId = parsed.log_id || "1";
                
                // If it's a real punch, save it
                if (parsed.user_id && parsed.io_time) {
                    const record = {
                        user_id: parsed.user_id,
                        time: parsed.io_time, // yyyymmddhhmmss format
                        mode: parsed.verify_mode || parsed.io_mode,
                        raw: parsed
                    };
                    fs.appendFileSync(getLogFile(), JSON.stringify(record) + ',\n');
                    logToConsoleAndFile(`🌟 SAVED | User: ${record.user_id} | Time: ${record.time}`);
                } else {
                    // It's a non-punch heartbeat, ping, or enroll backup!
                    logToConsoleAndFile(`🔧 SYSTEM PACKET: ${jsonSlice.toString('utf8')}`);
                }
                
                // 2. THE MAGICAL ACKNOWLEDGMENT
                // The Wireshark packet shows the exact format:
                // RTLOG003C[nulnulnul][Length Integer][JSON with \0 end][16 padding nuls]
                
                const ackJsonStr = `{\r\n  "log_id": "${logId}",\r\n  "result": "OK",\r\n  "mode": "nothing"\r\n}`;
                const jsonBuffer = Buffer.from(ackJsonStr + '\0', 'utf8');
                
                const headerBuffer = Buffer.alloc(16);
                headerBuffer.write('RTLOG003C', 0, 'ascii'); 
                headerBuffer.writeUInt8(0, 9);
                headerBuffer.writeUInt8(0, 10);
                headerBuffer.writeUInt8(0, 11);
                headerBuffer.writeInt32LE(jsonBuffer.length, 12);
                
                const paddingBuffer = Buffer.alloc(16);
                
                const finalAck = Buffer.concat([headerBuffer, jsonBuffer, paddingBuffer]);
                socket.write(finalAck);
                logToConsoleAndFile(`  ↩ ACK Sent: "RTLOG003C" -> Log ID: ${logId}`);
                
                // Safely remove the processed chunk from the buffer
                receiveBuffer = receiveBuffer.slice(end + 1);
                searchIndex = 0; // reset search index since buffer shifted
                madeChanges = true;
                
            } catch (err) {
                // If JSON fails to parse, it might be incomplete. Move search index forward 
                // to try the next closing brace block
                searchIndex = end + 1;
            }
        }
        
        // Failsafe: prevent memory leak if junk data builds up infinitely
        if (!madeChanges && receiveBuffer.length > 50000) {
            receiveBuffer = Buffer.alloc(0);
        }
    });

    socket.on('error', (err) => {
        // Ignored safely
    });

    socket.on('close', () => {
        // Ignored safely
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('───────────────────────────────────────────────────────');
    console.log('  Biomax NATIVE raw TCP Server');
    console.log(`  Port      : ${PORT}`);
    console.log(`  Log dir   : ${LOG_DIR}`);
    console.log('  Mode      : RTLOG003 Binary Interceptor');
    console.log('───────────────────────────────────────────────────────');
});
