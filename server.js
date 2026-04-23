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
    // 1. THE INVISIBLE HANDSHAKE
    // Tells the device we are the official server immediately upon connection
    const handshake = Buffer.from('bb6600a900000000000000000000ca0100', 'hex');
    socket.write(handshake);
    
    let receiveBuffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
        receiveBuffer = Buffer.concat([receiveBuffer, chunk]);

        let searchIndex = 0;
        let madeChanges = false;

        while (true) {
            const start = receiveBuffer.indexOf('{', searchIndex, 'utf8');
            if (start === -1) break;

            const end = receiveBuffer.indexOf('}', start, 'utf8');
            if (end === -1) break;

            const jsonSlice = receiveBuffer.slice(start, end + 1);
            
            try {
                const parsed = JSON.parse(jsonSlice.toString('utf8'));
                const responseId = parsed.log_id || parsed.backup_number || "1";
                
                // --- DETECT ATTENDANCE PUNCHES ---
                if (parsed.user_id && parsed.io_time) {
                    const statusMap = {
                        "0": "Check In",
                        "1": "Check Out",
                        "2": "Break In",
                        "3": "Break Out"
                    };
                    
                    const ioModeVal = parsed.io_mode || "0";
                    const checkStatus = statusMap[ioModeVal] || `Mode ${ioModeVal}`;

                    const record = {
                        card_user_id: parsed.user_id,
                        time: parsed.io_time,
                        status: checkStatus,
                        raw: parsed
                    };

                    fs.appendFileSync(getLogFile(), JSON.stringify(record) + ',\n');
                    
                    if (parsed.verify_mode === "IDCARD") {
                        console.log(`✅ [CARD SWIPE] >> CARD ID: ${parsed.user_id} | Mode: ${checkStatus}`);
                    } else {
                        console.log(`👤 [FINGERPINT] >> USER ID: ${parsed.user_id} | Mode: ${checkStatus}`);
                    }
                } else {
                    // Log system pings silently or with minimal info
                    if (!parsed.backup_number) {
                         console.log(`📡 Heartbeat received from device`);
                    }
                }
                
                // 2. THE MAGICAL ACKNOWLEDGMENT
                // Mirror the key (log_id or backup_number) and value to stop loops
                const responseObj = { result: "OK", mode: "nothing" };
                if (parsed.log_id) responseObj.log_id = parsed.log_id;
                if (parsed.backup_number) responseObj.backup_number = parsed.backup_number;
                if (!parsed.log_id && !parsed.backup_number) responseObj.log_id = "1";

                const ackJsonStr = JSON.stringify(responseObj, null, 2).replace(/\n/g, '\r\n');
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
                
                receiveBuffer = receiveBuffer.slice(end + 1);
                searchIndex = 0; 
                madeChanges = true;
                
            } catch (err) {
                searchIndex = end + 1;
            }
        }

        if (!madeChanges && receiveBuffer.length > 50000) {
            receiveBuffer = Buffer.alloc(0);
        }
    });

    socket.on('error', () => {});
    socket.on('close', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('───────────────────────────────────────────────────────');
    console.log('  Biomax N-E90 Pro | DIRECT TCP RELAY');
    console.log(`  ONLINE ON PORT: ${PORT}`);
    console.log('───────────────────────────────────────────────────────');
});
