const fs = require('fs'), cr = require('crypto');
const m = JSON.parse(fs.readFileSync('fixtures/MANIFEST.json', 'utf8'));
const pairs = [];
const dig = (o) => {
  if (Array.isArray(o)) return o.forEach(dig);
  if (o && typeof o === 'object') {
    const ks = Object.keys(o);
    const f = ks.find(k => (k === 'path' || k === 'file') && typeof o[k] === 'string' && /[\\/]/.test(o[k]));
    const s = ks.find(k => (k === 'sha256' || k === 'sha') && typeof o[k] === 'string' && /^[0-9a-f]{64}$/.test(o[k]));
    if (f && s) pairs.push([o[f], o[s]]);
    ks.forEach(k => dig(o[k]));
  }
};
dig(m);
let ok = 0, miss = 0, bad = 0;
for (const [p, s] of pairs) {
  const rp = p.split(String.fromCharCode(92)).join('/');
  const cand = [rp, 'fixtures/' + rp.replace(/^fixtures\//, ''), rp.replace(/^fixtures\//, 'fixtures/')];
  const f = cand.find(c => fs.existsSync(c));
  if (!f) { miss++; if (miss < 5) console.log('MISS', rp); continue; }
  const h = cr.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (h === s) ok++; else { bad++; if (bad < 5) console.log('BAD', rp); }
}
console.log('pairs', pairs.length, 'ok', ok, 'missing', miss, 'mismatch', bad);
process.exit(miss || bad ? 1 : 0);
