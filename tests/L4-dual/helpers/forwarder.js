'use strict';
// Loopback forwarder: 127.0.0.1:<publicPort> -> 127.0.0.1:7837.
//
// server.js hardcodes its own port (Q11 — settings.serverPort never moves it), so two managers can
// never listen at the same time, and a dual-run of two refs has to be sequential. The forwarder is
// what still gives each side a stable base URL of its own (7841 for A, 7842 for B): the suites get
// per-side URLs exactly as they will in Part 2, where a candidate is free to bind its own port, and
// legacy's Q11 constraint stays exactly as recorded instead of being worked around in the harness.

const net = require('net');

function listen(publicPort, targetPort) {
    const sockets = new Set();
    const server = net.createServer((incoming) => {
        sockets.add(incoming);
        incoming.on('error', () => {});
        const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort }, () => {
            incoming.pipe(upstream);
            upstream.pipe(incoming);
        });
        upstream.on('error', () => upstream.destroy());
        incoming.on('close', () => upstream.destroy());
        upstream.on('close', () => incoming.destroy());
    });
    server.on('connection', (socket) => socket.on('error', () => {}));
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(publicPort, '127.0.0.1', () => resolve({
            publicPort,
            targetPort,
            close: () => new Promise((done) => {
                for (const socket of sockets) socket.destroy();
                server.close(done);
            })
        }));
    });
}

module.exports = { listen };
