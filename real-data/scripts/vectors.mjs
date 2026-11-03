// Part 1 of PROTOCOL.md. Run from real-data/: node scripts/vectors.mjs
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, makeFixedHandler } from '../../src/fixed.js';
import { makeBrokenHandler } from '../../src/broken.js';
import { SECRET, newStore } from '../../src/common.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const NOW = 1_800_000_000;
const hmac = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
const stripeHeader = (secret, ts, payload) => `t=${ts},v1=${hmac(secret, `${ts}.${payload}`)}`;
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
let rows = 0, bad = 0;
const row = (id, expected, got, note = '') => {
  rows++;
  const ok = expected === got;
  if (!ok) bad++;
  say(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(46)} expected=${String(expected).padEnd(6)} got=${String(got).padEnd(6)} ${note}`);
};

say(`PROTOCOL.md sha256 ${createHash('sha256').update(readFileSync(join(root, 'PROTOCOL.md'))).digest('hex')}`);
say(`run at ${new Date().toISOString()}  node ${process.version}`);

// V1: GitHub doc vector
const gh = JSON.parse(readFileSync(join(root, 'data/github-doc-vector.json'), 'utf8'));
say('\n== V1 GitHub documented vector ==');
row('V1a HMAC-SHA256 equals documented value', true, hmac(gh.secret, gh.payload) === gh.signature_hex);
row('V1b lab verify() on GitHub header format', false, verify(gh.payload, gh.x_hub_signature_256, gh.secret, NOW), '(lab speaks Stripe-style only: coverage gap)');

// V2: Stripe scheme
const sc = JSON.parse(readFileSync(join(root, 'data/stripe-constants.json'), 'utf8'));
const sp = JSON.stringify(sc.event_payload, null, 2);
const tmp = mkdtempSync(join(tmpdir(), 'wrl-'));
writeFileSync(join(tmp, 'p.txt'), sp);
const py = execFileSync('python3', ['-I', join(here, 'stripe_ref.py'), sc.secret, String(NOW), join(tmp, 'p.txt')], { encoding: 'utf8' }).trim();
say('\n== V2 Stripe scheme (stripe-node constants) ==');
row('V2-ref Python HMAC equals Node HMAC', true, py === hmac(sc.secret, `${NOW}.${sp}`));
if (py !== hmac(sc.secret, `${NOW}.${sp}`)) { console.error('reference mismatch, stopping'); process.exit(2); }
const S = sc.secret;
const v = (h, p = sp, sec = S) => verify(p, h, sec, NOW);
row('S-valid t=NOW', true, v(stripeHeader(S, NOW, sp)));
row('S-age299', true, v(stripeHeader(S, NOW - 299, sp)));
row('S-age300 (boundary)', true, v(stripeHeader(S, NOW - 300, sp)));
row('S-age301', false, v(stripeHeader(S, NOW - 301, sp)));
row('S-future301', false, v(stripeHeader(S, NOW + 301, sp)), '(stripe-node would accept; lab stricter)');
row('S-tamper (1 byte)', false, v(stripeHeader(S, NOW, sp), sp.replace('evt_test', 'evt_best')));
row('S-wrongsecret', false, v(stripeHeader('whsec_other', NOW, sp)));
row('S-v0only', false, v(`t=${NOW},v0=${hmac(S, `${NOW}.${sp}`)}`));
row('S-rotation (two v1, second right)', true, v(`t=${NOW},v1=${'a'.repeat(64)},v1=${hmac(S, `${NOW}.${sp}`)}`));
row('S-docs-header (no key for it, must not throw)', false, verify(sp, sc.docs_example_header, S, 1492774577));
row('S-nohex (64 non-hex chars)', false, v(`t=${NOW},v1=${'z'.repeat(64)}`));

// V3: real payload bytes, signature check only
const dir = join(root, 'data/octokit');
const files = readdirSync(dir).filter((f) => f.endsWith('.json.gz')).sort();
say(`\n== V3 ${files.length} real octokit payloads, verify() only ==`);
const flip = (s) => { const i = s.length >> 1; return s.slice(0, i) + (s[i] === 'x' ? 'y' : 'x') + s.slice(i + 1); };
const payloads = {};
for (const f of files) {
  const name = f.replace('.json.gz', '');
  const body = gunzipSync(readFileSync(join(dir, f))).toString('utf8');
  payloads[name] = body;
  const okSha = createHash('sha256').update(body).digest('hex');
  const want = readFileSync(join(dir, 'ORIGINAL-SHA256.txt'), 'utf8').split('\n').find((l) => l.endsWith(`  ${name}.json`)).split(' ')[0];
  row(`${name}: bytes match recorded sha256`, true, okSha === want, `${body.length}B`);
  const h = stripeHeader(SECRET, NOW, body);
  row(`${name}: valid`, true, verify(body, h, SECRET, NOW));
  row(`${name}: tampered`, false, verify(flip(body), h, SECRET, NOW));
  row(`${name}: wrong secret`, false, verify(body, stripeHeader('whsec_other', NOW, body), SECRET, NOW));
  row(`${name}: stale NOW-3600`, false, verify(body, stripeHeader(SECRET, NOW - 3600, body), SECRET, NOW));
  row(`${name}: future NOW+3600`, false, verify(body, stripeHeader(SECRET, NOW + 3600, body), SECRET, NOW));
  row(`${name}: trailing space after signing`, false, verify(body + ' ', h, SECRET, NOW));
}

// V4: end to end through both handlers
say('\n== V4 end to end, broken vs fixed ==');
const cases = ['valid', 'tampered', 'wrongsecret', 'stale', 'forgedzero'];
const tally = { broken: {}, fixed: {} };
for (const name of Object.keys(payloads)) {
  const env = JSON.stringify({ id: `octokit-${name}`, type: 'invoice.paid', created: NOW, data: { customer: `octokit-${name}`, amount: 1, payload: JSON.parse(payloads[name]) } });
  const mk = {
    broken: () => { const s = newStore(); return [s, makeBrokenHandler(s)]; },
    fixed: () => { const s = newStore(); return [s, makeFixedHandler(s, { secret: SECRET, now: () => NOW })]; },
  };
  const deliveries = {
    valid: [env, stripeHeader(SECRET, NOW, env)],
    tampered: [env.replace('"amount":1', '"amount":9'), stripeHeader(SECRET, NOW, env)],
    wrongsecret: [env, stripeHeader('whsec_other', NOW, env)],
    stale: [env, stripeHeader(SECRET, NOW - 3600, env)],
    forgedzero: [env, `t=${NOW},v1=${'0'.repeat(64)}`],
  };
  for (const impl of ['broken', 'fixed']) {
    for (const c of cases) {
      const [store, h] = mk[impl]();
      const r = await h(...deliveries[c]);
      const accepted = r.status === 200 && (store.balances.get(`octokit-${name}`) ?? 0) > 0;
      (tally[impl][c] ??= { accepted: 0, total: 0 });
      tally[impl][c].total++; if (accepted) tally[impl][c].accepted++;
    }
  }
}
for (const impl of ['broken', 'fixed']) {
  for (const c of cases) {
    const t = tally[impl][c];
    const exp = c === 'valid' ? t.total : 0;
    row(`V4 ${impl}: ${c} accepted (of ${t.total})`, exp, t.accepted, impl === 'broken' && c !== 'valid' ? '(broken has no signature check)' : '');
  }
}

// V5: constant-time compare present in source
const src = readFileSync(join(root, '..', 'src/fixed.js'), 'utf8');
say('\n== V5 constant-time compare (source read, not timing) ==');
row('fixed.js imports and calls timingSafeEqual', true, /import \{[^}]*timingSafeEqual[^}]*\}/.test(src) && /timingSafeEqual\(given, expected\)/.test(src));
row('fixed.js has no === on signature strings', true, !/(sigs?|given|expected)[^\n]*={2,3}\s*(sigs?|given|expected)\b/.test(src.replace(/given\.length === expected\.length/g, '')));

say(`\nrows ${rows}, rows where got != expected: ${bad}`);
writeFileSync(join(root, 'evidence/vectors-run.txt'), out.join('\n') + '\n');
