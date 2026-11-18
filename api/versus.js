// re:collect versus: who's online, random matches, challenges, and the match itself.
// GET  /api/versus                 -> { online, invites, sent, notes, match, searching }   (also marks you online)
// GET  /api/versus?m=<id>          -> the match as you see it (and plays a timed-out turn, if one is due)
// POST /api/versus { op, ... }     -> queue | unqueue | challenge | cancel | answer | move | resign | leave
// Same player ids as the board: a wallet session (x-session) or a device id + key (x-player / x-key).
// Every key starts with "rc:vs:" so it can share the database with everything else.
import { redis, who } from './recollect.js';
import { cleanMe, newMatch, play, tick, view, forfeit, rebuild, INVITE_S, ONLINE_S, TURN_S } from '../lib/versus.js';

const ON = 'rc:vs:on', WAIT = 'rc:vs:wait';
const inv = pid => 'rc:vs:inv:' + pid, mine = pid => 'rc:vs:mine:' + pid, mk = id => 'rc:vs:m:' + id, note = pid => 'rc:vs:note:' + pid;
const MATCH_TTL = 6 * 3600;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const rid = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join(''); };
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

async function getMatch(id) {
  if (!/^[a-z0-9]{12}$/.test(id || '')) throw fail('No such match.', 404);
  const m = parse(await redis(['GET', mk(id)]));
  if (!m) throw fail('That match is over.', 404);
  return m;
}
const saveMatch = m => redis(['SET', mk(m.id), JSON.stringify(m), 'EX', String(MATCH_TTL)]);
// one change at a time per match
async function locked(id, fn) {
  const key = 'rc:vs:lock:' + id;
  for (let i = 0; i < 12; i++) {
    if ((await redis(['SET', key, '1', 'NX', 'PX', '4000'])) === 'OK') {
      try { return await fn(); } finally { await redis(['DEL', key]); }
    }
    await new Promise(r => setTimeout(r, 120));
  }
  throw fail('Busy. Try again.', 409);
}
async function start(a, b, pidA, pidB) {
  const m = newMatch(rid(), a, b, pidA, pidB);
  await saveMatch(m);
  await redis(['SET', mine(pidA), m.id, 'EX', String(MATCH_TTL)]);
  await redis(['SET', mine(pidB), m.id, 'EX', String(MATCH_TTL)]);
  return m;
}
const sideOf = (m, pid) => m.p[0].pid === pid ? 0 : m.p[1].pid === pid ? 1 : -1;

export async function GET(req) {
  try {
    const q = new URL(req.url).searchParams;
    const me = await who(req);
    if (q.has('m')) {
      const id = q.get('m');
      let m = await getMatch(id);
      const side = sideOf(m, me.id); if (side < 0) throw fail('Not your match.', 403);
      if (!m.over && Date.now() - m.turnAt >= TURN_S * 1000) m = await locked(id, async () => { const x = await getMatch(id); if (tick(x)) await saveMatch(x); return x; });
      return json({ match: view(m, side) });
    }
    // the lobby
    const now = Date.now();
    const card = cleanMe(parse(q.get('me')) || {});
    await redis(['HSET', ON, me.id, JSON.stringify({ t: now, name: card.name, face: card.face, lvl: card.lvl })]);
    const flat = (await redis(['HGETALL', ON])) || [], online = [], stale = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const r = parse(flat[i + 1]); if (!r) continue;
      if (now - r.t > 10 * 60000) stale.push(flat[i]);
      else if (flat[i] !== me.id && now - r.t < ONLINE_S * 1000) online.push({ id: flat[i], name: r.name, face: r.face, lvl: r.lvl });
    }
    if (stale.length) await redis(['HDEL', ON, ...stale]);
    const iflat = (await redis(['HGETALL', inv(me.id)])) || [], invites = [];
    for (let i = 0; i + 1 < iflat.length; i += 2) { const r = parse(iflat[i + 1]); if (r && now - r.t < INVITE_S * 1000) invites.push({ id: iflat[i], name: r.name, face: r.face, lvl: r.lvl, left: INVITE_S * 1000 - (now - r.t) }); }
    const notes = parse(await redis(['GETDEL', note(me.id)])) || [];
    const w = parse(await redis(['GET', WAIT]));
    const match = await redis(['GET', mine(me.id)]);
    return json({ me: me.id, online: online.slice(0, 30), invites, notes, searching: !!(w && w.pid === me.id), match: match || null });
  } catch (e) { return json({ error: e.message }, e.status || 500); }
}

export async function POST(req) {
  try {
    const raw = await req.text();
    if (raw.length > 8000) return json({ error: 'Too big.' }, 413);
    const b = parse(raw || '{}') || {};
    const me = await who(req, b), now = Date.now();
    const card = () => cleanMe(b.me);
    switch (b.op) {
      case 'queue': {   // random: join whoever is waiting, or wait
        const c = card();
        for (let i = 0; i < 2; i++) {
          const w = parse(await redis(['GET', WAIT]));
          if (w && w.pid === me.id) { await redis(['SET', WAIT, JSON.stringify({ ...w, t: now }), 'EX', '25']); return json({ searching: true }); }
          if (w && now - w.t < 25000) {
            const got = parse(await redis(['GETDEL', WAIT]));
            if (got && got.pid !== me.id) { const m = await start(got.card, c, got.pid, me.id); return json({ match: m.id }); }
          }
          if ((await redis(['SET', WAIT, JSON.stringify({ pid: me.id, card: c, t: now }), 'NX', 'EX', '25'])) === 'OK') return json({ searching: true });
        }
        return json({ searching: false, error: 'Try again.' }, 409);
      }
      case 'unqueue': { const w = parse(await redis(['GET', WAIT])); if (w && w.pid === me.id) await redis(['DEL', WAIT]); return json({ ok: true }); }
      case 'challenge': {
        const to = String(b.to || '');
        if (!to || to === me.id || to.length > 64) throw fail('Pick someone to challenge.');
        const c = card();
        await redis(['HSET', inv(to), me.id, JSON.stringify({ t: now, name: c.name, face: c.face, lvl: c.lvl, card: c })]);
        await redis(['EXPIRE', inv(to), '600']);
        return json({ ok: true });
      }
      case 'cancel': { await redis(['HDEL', inv(String(b.to || '')), me.id]); return json({ ok: true }); }
      case 'answer': {
        const from = String(b.from || '');
        const r = parse(await redis(['HGET', inv(me.id), from]));
        await redis(['HDEL', inv(me.id), from]);
        if (!r || now - r.t > INVITE_S * 1000) throw fail('That challenge ran out.', 410);
        const c = card();
        const pushNote = async text => { const n = parse(await redis(['GET', note(from)])) || []; n.push({ t: now, text, id: me.id }); await redis(['SET', note(from), JSON.stringify(n.slice(-5)), 'EX', '600']); };
        if (!b.yes) { await pushNote(`${c.name} said no.`); return json({ ok: true }); }
        const m = await start(r.card, c, from, me.id);
        return json({ match: m.id });
      }
      case 'move': {
        const id = String(b.m || '');
        const out = await locked(id, async () => {
          const m = await getMatch(id), side = sideOf(m, me.id);
          if (side < 0) throw fail('Not your match.', 403);
          if (m.over) return m;
          const mv = { by: -1, a: String(b.a || '') };
          if (mv.a === 'auto') throw fail('Unknown move.');
          // the move is checked from the server's own table; side numbers are the server's
          const st0 = rebuild(m);
          if (st0.g.turn !== side) throw fail("It isn't your turn.", 409);
          mv.by = side;
          if (b.pick != null) mv.pick = b.pick === 'pile' ? 'pile' : +b.pick;
          if (b.k != null) mv.k = +b.k;
          if (b.cards != null) mv.cards = b.cards;
          play(m, mv);
          m.idle[side] = 0;
          await saveMatch(m);
          return m;
        });
        return json({ match: view(out, sideOf(out, me.id)) });
      }
      case 'resign': {
        const id = String(b.m || '');
        const out = await locked(id, async () => {
          const m = await getMatch(id), side = sideOf(m, me.id);
          if (side < 0) throw fail('Not your match.', 403);
          forfeit(m, side, 'resigned'); await saveMatch(m); return m;
        });
        return json({ match: view(out, sideOf(out, me.id)) });
      }
      case 'leave': {   // done with a finished match
        const id = await redis(['GET', mine(me.id)]);
        if (id) { const m = parse(await redis(['GET', mk(id)])); if (!m || m.over) await redis(['DEL', mine(me.id)]); }
        return json({ ok: true });
      }
    }
    throw fail('Unknown request.');
  } catch (e) { return json({ error: e.message }, e.status || 500); }
}
