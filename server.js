const net = require('net');

console.log('Sending EXACT Biomax payload to SDK...');

const client = new net.Socket();
client.connect(7005, '127.0.0.1', () => {
    
    // The exact physical punch string we saw repeating in Railway logs
    const payload = '{"fk_bin_data_lib":"FKDataHS102","io_mode":16777216,"io_time":"20260326171043","log_image":null,"user_id":"1","verify_mode":268435456}';
    
    const httpRequest = [
        'POST /hdata.aspx HTTP/1.0',
        'request_code: realtime_glog', 
        'cmd_id: RTLogSendAction', // SDK seems to use this
        'dev_id: C264B0520F3A1E2C', // From our logs
        'Content-Type: application/octet-stream',
        `Content-Length: ${payload.length}`,
        '',
        payload
    ].join('\r\n');

    client.write(httpRequest);
});

let respBuffer = Buffer.alloc(0);
client.on('data', (d) => {
    respBuffer = Buffer.concat([respBuffer, d]);
});

client.on('close', () => {
    console.log('\n--- ALL RESPONSE BYTES ---');
    console.log(respBuffer.toString('hex'));
});
