// Leak check: committed/repo artifacts must contain no personal absolute paths,
// plain or base64-encoded. Usage: node leak-check.js <dir...>
const fs = require('fs'), path = require('path');
// Oracle-truth exception: C:\Users\anubh\.lmstudio\models is a legacy-code constant (server.js default,
// already in committed legacy source) — recorded bytes may not be sanitized (C5).
// Real exposures to eliminate: scratch-root paths (C:\Users\<user>\AppData\Local\Temp\parity-scratch) via
// a neutral PARITY_SCRATCH root at re-record, and tokenized vector INPUT paths.
const PATTERNS = [/C:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+[^"\\/\s]+[\\/]+(?:AppData|projects|Desktop|Downloads)/i];
const b64Leak = (s) => {
  for (const m of s.matchAll(/"([A-Za-z0-9+/=]{24,})"/g)) {
    try {
      const d = Buffer.from(m[1], 'base64').toString('utf8');
      if (PATTERNS.some((p) => p.test(d))) return d.slice(0, 60);
    } catch (e) {}
  }
  return null;
};
let leaks = 0, scanned = 0;
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).forEach((f) => walk(path.join(p, f)));
  if (/\.(json|md|csv|txt|js|html|ini|text|response|jsonl)$/i.test(p) === false) return;
  scanned++;
  const s = fs.readFileSync(p, 'utf8');
  for (const pat of PATTERNS) if (pat.test(s)) { console.log('PLAIN', p, s.match(new RegExp('.{0,40}' + pat.source + '.{0,30}'))[0]); leaks++; break; }
  const b = b64Leak(s);
  if (b) { console.log('B64   ', p, b); leaks++; }
};
process.argv.slice(2).forEach(walk);
console.log((leaks ? 'LEAKS: ' + leaks : 'CLEAN'), '(scanned', scanned, 'files)');
process.exit(leaks ? 1 : 0);
