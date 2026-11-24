'use strict';
// One side of a dual run: the L3 seam sandbox (the L1 sandbox with settings/ini/corpus access), with
// every request — the suite's own and the browser's — going through that side's public port. The
// manager process itself still binds 7837 (Q11), which is why the two sides run sequentially behind a
// loopback forwarder rather than at the same time.

const http = require('http');

const { SeamSandbox } = require('../../L3-seam/helpers/sandbox');

class DualSandbox extends SeamSandbox {
    constructor(options) {
        super(options);
        this.publicPort = options.publicPort;
        this.baseUrl = 'http://localhost:' + this.publicPort;
    }

    request(method, route, body, headers) {
        return new Promise((resolve, reject) => {
            const payload = body === undefined || body === null ? null
                : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));
            const sendHeaders = { Accept: '*/*', ...(headers || {}) };
            if (payload) {
                sendHeaders['Content-Type'] = sendHeaders['Content-Type'] || 'application/json';
                sendHeaders['Content-Length'] = String(payload.length);
            }
            const req = http.request({
                host: '127.0.0.1', port: this.publicPort, method, path: route,
                agent: new http.Agent({ keepAlive: false }), headers: sendHeaders
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks) }));
            });
            req.on('error', reject);
            req.setTimeout(30000, () => req.destroy(new Error('timeout ' + method + ' ' + route)));
            if (payload) req.write(payload);
            req.end();
        });
    }
}

module.exports = { DualSandbox };
