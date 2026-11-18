// re:collect: the board, each player's save, and optional wallet sign-in.
// Standard Web Request -> Response handlers (Vercel runs these as they are).
// Storage: Upstash Redis over its REST API. Every key starts with "rc:" so it can share a database.
import { getAddress } from 'viem';
import { verify, holdings, walletReady, vaults } from '../lib/wallet.js';

const URL_ = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const BOARD = 'rc:board', KEYS = 'rc:keys';
const MAX_SAVE = 80000;              // a full wall of 6,666 is ~33 KB
const DEVICE = /^[a-z0-9]{16}$/, KEY = /^[a-z0-9]{32}$/, ADDR = /^0x[0-9a-f]{40}$/, TOK = /^[a-z0-9]{32}$/;
const SESSION_S = 7 * 86400;         // seven days

export async function redis(cmd) {
  if (!URL_() || !TOKEN()) throw Object.assign(new Error('The database is not connected yet.'), { status: 503 });
  const r = await fetch(URL_(), { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN(), 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'Database error');
  return j.result;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const rnd = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join(''); };
const int = (v, lo, hi) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : lo;
export function cleanName(s) { return String(s || '').replace(/[^A-Za-z0-9 .\-_#:]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); }
export function cleanRow(r, name, holder) {
  if (!r || typeof r !== 'object') return null;
  const w = r.week && typeof r.week === 'object' ? r.week : {};
  const row = {
    v: 2, name: cleanName(name), xp: int(r.xp, 0, 1e8), wall: int(r.wall, 0, 6666), badges: int(r.badges, 0, 100), best: int(r.best, -200, 2000),
    face: int(r.face, 1, 6666),
    week: { id: /^w\d{1,5}$/.test(w.id) ? w.id : 'w0', xp: int(w.xp, 0, 1e7), wins: int(w.wins, 0, 1e5), games: int(w.games, 0, 1e5), done: int(w.done, 0, 3) },
    t: Date.now(),
  };
  if (holder != null) row.holder = int(holder, 0, 6666);
  return row;
}
// a device player: a random id plus a secret key kept on that device; the first save claims the id
async function checkDevice(id, key) {
  if (!DEVICE.test(id || '') || !KEY.test(key || '')) throw fail('Bad player id.');
  const h = await sha(key);
  const had = await redis(['HSETNX', KEYS, id, h]);
  if (had === 0 && (await redis(['HGET', KEYS, id])) !== h) throw fail('That player belongs to another device.', 403);
  return id;
}
// a wallet player: a session handed out when they signed in
async function checkSession(token) {
  if (!TOK.test(token || '')) throw fail('Sign in again.', 401);
  const addr = await redis(['GET', 'rc:sess:' + token]);
  if (!addr) throw fail('Sign in again.', 401);
  return addr;
}
async function who(req, b = {}) {
  const s = req.headers.get('x-session') || b.session;
  if (s) return { id: await checkSession(s), wallet: true };
  return { id: await checkDevice(req.headers.get('x-player') || b.id, req.headers.get('x-key') || b.key), wallet: false };
}
async function held(addr, fresh) {
  const k = 'rc:hold:' + addr;
  if (!fresh) { const c = await redis(['GET', k]); if (c) return JSON.parse(c); }
  const list = await holdings(addr);
  await redis(['SET', k, JSON.stringify(list), 'EX', '300']);
  return list;
}
// the message names the site the person is on, so their wallet shows the right address
function siteHost(h) {
  h = String(h || '').toLowerCase();
  if (process.env.SITE_HOST && h === process.env.SITE_HOST.toLowerCase()) return h;
  return /^(localhost(:\d{2,5})?|([a-z0-9-]+\.)*mechsicko\.art|[a-z0-9-]+\.vercel\.app)$/.test(h) ? h : 'mechsicko.art';
}

export async function GET(req) {
  try {
    const u = new URL(req.url), q = u.searchParams;
    if (q.has('status')) return json({ wallet: walletReady(), vaults: vaults().length, database: !!(URL_() && TOKEN()) });
    if (q.has('nonce')) {
      if (!walletReady()) throw fail('Wallet sign-in is not set up on this site yet.', 503);
      const address = String(q.get('address') || '').toLowerCase();
      if (!ADDR.test(address)) throw fail('That is not a wallet address.');
      const host = siteHost(q.get('host')), nonce = rnd(16);
      const message = `${host} wants you to sign in with your Ethereum account:\n${getAddress(address)}\n\nSign in to re:collect. It's free and moves nothing.\n\nURI: https://${host}\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
      await redis(['SET', 'rc:nonce:' + nonce, JSON.stringify({ address, message }), 'EX', '600']);
      return json({ nonce, message });
    }
    if (q.has('save')) {
      const me = await who(req);
      const s = await redis(['GET', 'rc:save:' + me.id]);
      return json({ save: s ? JSON.parse(s) : null });
    }
    if (q.has('regens')) {
      const addr = await checkSession(req.headers.get('x-session'));
      return json({ address: addr, regens: await held(addr, q.has('fresh')) });
    }
    const flat = (await redis(['HGETALL', BOARD])) || [];
    const rows = {};
    for (let i = 0; i + 1 < flat.length; i += 2) { try { rows[flat[i]] = JSON.parse(flat[i + 1]); } catch {} }
    return json({ rows, wallet: walletReady() });
  } catch (e) { return json({ error: e.message }, e.status || 500); }
}

export async function POST(req) {
  try {
    const raw = await req.text();
    if (raw.length > MAX_SAVE + 4000) return json({ error: 'Too big.' }, 413);
    const b = JSON.parse(raw || '{}');
    if (b.op === 'login') {
      const n = /^[a-z0-9]{16}$/.test(b.nonce || '') ? await redis(['GETDEL', 'rc:nonce:' + b.nonce]) : null;
      if (!n) throw fail('That sign-in expired. Try again.', 401);
      const { address, message } = JSON.parse(n);
      if (typeof b.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(b.signature) || !(await verify(address, message, b.signature))) throw fail("That signature didn't check out.", 401);
      const session = rnd(32);
      await redis(['SET', 'rc:sess:' + session, address, 'EX', String(SESSION_S)]);
      // the device's row folds into the wallet's, so nobody shows up twice
      if (DEVICE.test(b.device && b.device.id || '') && KEY.test(b.device && b.device.key || '')) {
        try { await checkDevice(b.device.id, b.device.key); await redis(['HDEL', BOARD, b.device.id]); } catch {}
      }
      const s = await redis(['GET', 'rc:save:' + address]);
      let regens = [];
      try { regens = await held(address, true); } catch {}
      return json({ session, address, regens, save: s ? JSON.parse(s) : null });
    }
    if (b.op === 'logout') { if (TOK.test(b.session || '')) await redis(['DEL', 'rc:sess:' + b.session]); return json({ ok: true }); }
    // a save
    const me = await who(req, b);
    if ((await redis(['SET', 'rc:rl:' + me.id, '1', 'NX', 'EX', '2'])) !== 'OK') return json({ error: 'Slow down.' }, 429);
    let holder = null;
    if (me.wallet) { try { holder = (await held(me.id)).length; } catch { holder = 0; } }
    const row = cleanRow(b.row, b.name, holder);
    if (!row) return json({ error: 'Bad row.' }, 400);
    await redis(['HSET', BOARD, me.id, JSON.stringify(row)]);
    if (b.save && typeof b.save === 'object') {
      const s = JSON.stringify(b.save);
      if (s.length <= MAX_SAVE) await redis(['SET', 'rc:save:' + me.id, s]);
    }
    return json({ ok: true, row });
  } catch (e) { return json({ error: e.message }, e.status || 500); }
}
