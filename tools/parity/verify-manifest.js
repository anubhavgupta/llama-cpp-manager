const fs = require('fs'), cr = require('crypto');
// F11 (AUDIT-2026-11-25): the recorded corpus remappings appeared in neither manifest, so their only
// provenance was PATH-MAP.json#generatedBy. `load-corpus.js --emit` now writes
// fixtures/corpus/MANIFEST.json, and a manifest nobody checks is a list of claims, so both of them
// are verified here.
const MANIFESTS = ['fixtures/MANIFEST.json', 'fixtures/corpus/MANIFEST.json'];
const totals = { pairs: 0, ok: 0, miss: 0, bad: 0 };
for (const manifest of MANIFESTS) {
  if (!fs.existsSync(manifest)) { console.log('NO MANIFEST', manifest); process.exit(1); }
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
  dig(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  let ok = 0, miss = 0, bad = 0;
  for (const [p, s] of pairs) {
    const rp = p.split(String.fromCharCode(92)).join('/');
    const cand = [rp, 'fixtures/' + rp.replace(/^fixtures\//, ''), rp.replace(/^fixtures\//, 'fixtures/')];
    const f = cand.find(c => fs.existsSync(c));
    if (!f) { miss++; if (miss < 5) console.log('MISS', rp); continue; }
    const h = cr.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (h === s) ok++; else { bad++; if (bad < 5) console.log('BAD', rp); }
  }
  console.log(manifest + ': pairs', pairs.length, 'ok', ok, 'missing', miss, 'mismatch', bad);
  totals.pairs += pairs.length; totals.ok += ok; totals.miss += miss; totals.bad += bad;
}
console.log('TOTAL pairs', totals.pairs, 'ok', totals.ok, 'missing', totals.miss, 'mismatch', totals.bad);
process.exit(totals.miss || totals.bad ? 1 : 0);
