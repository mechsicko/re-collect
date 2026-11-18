// re:collect versus: two people at one table. The server deals, keeps both hands secret and checks every move
// with the same rules engine the page uses (lib/engine.cjs). A match is stored as its seed plus the list of moves,
// and rebuilt by replaying them, so the server never trusts a client's idea of the table.
import RC from './engine.cjs';
import { createRequire } from 'node:module';
const DATA = createRequire(import.meta.url)('./regen-data.json');
RC.init(DATA);

export const TURN_S = +process.env.RC_TURN_S || 60;   // seconds a turn may take; after that the server plays the turn for you
export const IDLE_OUT = 3;         // three timed-out turns in a row and the match is forfeit
export const INVITE_S = 45;        // a challenge is open this long
export const ONLINE_S = 25;        // seen this recently = online

const int = v => Number.isInteger(v) ? v : NaN;
// a player's card: what the other side sees
export function cleanMe(me) {
  me = me && typeof me === 'object' ? me : {};
  const name = String(me.name || '').replace(/[^A-Za-z0-9 .\-_#:]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  const home = Array.isArray(me.home) ? me.home.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= RC.N).slice(0, 3) : [];
  while (home.length < 3) home.push(1 + Math.floor(Math.random() * RC.N));
  const face = Number.isInteger(+me.face) && +me.face >= 1 && +me.face <= RC.N ? +me.face : home[0];
  const lvl = Math.max(1, Math.min(100, Math.round(+me.lvl || 1)));
  const m = me.mods && typeof me.mods === 'object' ? me.mods : {};
  const feature = Number.isInteger(m.feature) && m.feature >= 0 && m.feature < 12 ? m.feature : null;
  const wanted = Array.isArray(m.wanted) ? m.wanted.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= RC.N).slice(0, 12) : [];
  return { name: name || '#' + face, face, lvl, home, mods: { feature, wanted } };
}

export function newMatch(id, a, b, pidA, pidB) {
  const seed = (Math.random() * 2 ** 31) | 0;
  return {
    id, seed, v: 1, t0: Date.now(), turnAt: Date.now(),
    p: [{ pid: pidA, name: a.name, face: a.face, lvl: a.lvl }, { pid: pidB, name: b.name, face: b.face, lvl: b.lvl }],
    homes: [a.home, b.home], mods: a.mods, first: Math.random() < 0.5 ? 0 : 1,
    moves: [], idle: [0, 0], over: false, result: null,
  };
}

/* ---------- the turn, the same way the page plays it ---------- */
// take one card at a time (two a turn), or lay sets down then end the turn; over nine in hand -> put the extras face up
function freshTurn() { return { taken: 0, laid: false, need: 0 }; }
function endTurn(g, T) { RC.endTurn(g); Object.assign(T, freshTurn()); }
function afterTake(g, T) {
  if (T.taken >= RC.RULES.take || (!g.pile.length && !g.faceUp.length)) {
    const over = g.players[g.turn].hand.length - RC.RULES.handMax;
    if (over > 0) T.need = over; else endTurn(g, T);
  }
}
const fail = msg => Object.assign(new Error(msg), { status: 400 });
function apply(g, T, mv, log) {
  const pi = g.turn, p = g.players[pi], a = mv.a;
  if (g.over) throw fail('The game is over.');
  if (mv.by !== pi) throw fail("It isn't your turn.");
  if (a === 'take') {
    if (T.laid) throw fail('You laid down this turn. End your turn.');
    if (T.need) throw fail('Put your extra cards face up first.');
    if (T.taken >= RC.RULES.take) throw fail('You already took two.');
    const pick = mv.pick === 'pile' ? 'pile' : int(mv.pick);
    if (pick === 'pile' ? !g.pile.length : !(pick >= 0 && pick < g.faceUp.length)) throw fail('That card is gone.');
    const [[from, n]] = RC.take(g, [pick]);
    T.taken++;
    log.push({ by: pi, a: 'take', from, n: from === 'face' ? n : null, secret: n });
    afterTake(g, T);
  } else if (a === 'lay') {
    if (T.taken) throw fail('Take one more card first.');
    if (T.need) throw fail('Put your extra cards face up first.');
    const k = int(mv.k), cards = Array.isArray(mv.cards) ? mv.cards.map(Number) : [];
    if (!Number.isInteger(k) || !cards.length || new Set(cards).size !== cards.length) throw fail('Pick the cards for the set.');
    let res; try { [res] = RC.recollect(g, [{ k, cards }]); } catch (e) { throw fail(e.message); }
    T.laid = true;
    log.push({ by: pi, a: 'lay', k, cards: res.cards, pts: res.pts, add: res.add });
  } else if (a === 'discard') {
    const cards = Array.isArray(mv.cards) ? mv.cards.map(Number) : [];
    if (!T.need) throw fail('Nothing to put face up.');
    if (cards.length !== T.need || new Set(cards).size !== cards.length || !cards.every(n => p.hand.includes(n))) throw fail(`Pick ${T.need} from your hand.`);
    RC.discard(g, cards);
    log.push({ by: pi, a: 'discard', cards });
    endTurn(g, T);
  } else if (a === 'end') {
    const stuck = !g.pile.length && !g.faceUp.length && !T.taken;
    if (!T.laid && !stuck) throw fail('Take two, or lay a set down.');
    log.push({ by: pi, a: 'end' });
    endTurn(g, T);
  } else if (a === 'auto') {
    // the clock ran out: finish the turn the simplest fair way
    log.push({ by: pi, a: 'auto' });
    if (T.need) {
      const drop = p.hand.slice().sort((x, y) => RC.cardWorth(g, pi, x) - RC.cardWorth(g, pi, y)).slice(0, T.need);
      RC.discard(g, drop); log.push({ by: pi, a: 'discard', cards: drop }); endTurn(g, T);
    } else if (T.taken) {
      while (T.taken && T.taken < RC.RULES.take && (g.pile.length || g.faceUp.length)) {
        const pick = g.pile.length ? 'pile' : 0, [[from, n]] = RC.take(g, [pick]); T.taken++;
        log.push({ by: pi, a: 'take', from, n: from === 'face' ? n : null, secret: n });
      }
      const over = p.hand.length - RC.RULES.handMax;
      if (over > 0) { const drop = p.hand.slice().sort((x, y) => RC.cardWorth(g, pi, x) - RC.cardWorth(g, pi, y)).slice(0, over); RC.discard(g, drop); log.push({ by: pi, a: 'discard', cards: drop }); }
      endTurn(g, T);
    } else if (T.laid) endTurn(g, T);
    else {
      const res = RC.houseTurn(g, 'sharp');   // plays and ends the whole turn
      if (res.kind === 'recollect') for (const d of res.done) log.push({ by: pi, a: 'lay', k: d.k, cards: d.cards, pts: d.pts, add: d.add });
      else { for (const [from, n] of res.got) log.push({ by: pi, a: 'take', from, n: from === 'face' ? n : null, secret: n }); if (res.dropped.length) log.push({ by: pi, a: 'discard', cards: res.dropped }); }
      Object.assign(T, freshTurn());
    }
  } else throw fail('Unknown move.');
}

// rebuild the table from the seed and the moves
export function rebuild(m) {
  const g = RC.newGame(m.seed, m.homes.map(h => h.slice()), { feature: m.mods.feature, wanted: new Set(m.mods.wanted) });
  g.turn = m.first;
  const T = freshTurn(), log = [];
  for (const mv of m.moves) apply(g, T, mv, log);
  return { g, T, log };
}
// try a move: returns the new table, or throws (nothing is saved)
export function play(m, mv) {
  const st = rebuild(m);
  apply(st.g, st.T, mv, st.log);
  m.moves.push(mv); m.v++;
  if (st.g.turn !== mv.by || st.g.over) m.turnAt = Date.now();
  settle(m, st.g);
  return st;
}
export function settle(m, g) {
  if (g.over && !m.over) {
    m.over = true;
    m.result = { winner: g.winner, scores: g.players.map(p => p.score), why: 'played' };
  }
}
// a player's turn ran out (called when anyone looks at the match)
export function tick(m) {
  if (m.over) return false;
  if (Date.now() - m.turnAt < TURN_S * 1000) return false;
  const st = rebuild(m), pi = st.g.turn;
  m.idle[pi] = (m.idle[pi] || 0) + 1;
  if (m.idle[pi] >= IDLE_OUT) { forfeit(m, pi, 'timeout', st.g); return true; }
  play(m, { by: pi, a: 'auto' });
  return true;
}
export function forfeit(m, pi, why, g) {
  if (m.over) return;
  g = g || rebuild(m).g;
  m.over = true; m.turnAt = Date.now(); m.v++;
  m.result = { winner: 1 - pi, scores: g.players.map(p => p.score), why, by: pi };
}

// what player `me` (0 or 1) may see. In the view, side 0 is always "you" and side 1 the other player.
export function view(m, me) {
  const { g, T, log } = rebuild(m);
  const side = i => (i === me ? 0 : 1), you = g.players[me], them = g.players[1 - me];
  const sets = p => p.sets.map(s => ({ k: s.k, cards: s.cards, pts: s.pts }));
  const r = m.result;
  return {
    id: m.id, v: m.v,
    you: { name: m.p[me].name, face: m.p[me].face, home: m.homes[me] },
    them: { id: m.p[1 - me].pid, name: m.p[1 - me].name, face: m.p[1 - me].face, lvl: m.p[1 - me].lvl, home: m.homes[1 - me] },
    mods: m.mods,
    faceUp: g.faceUp, pile: g.pile.length, lastRound: g.lastRound >= 0,
    hand: you.hand, theirHand: them.hand.length,
    sets: [sets(you), sets(them)], scores: [you.score, them.score],
    turn: g.over || m.over ? -1 : side(g.turn),
    T: !m.over && g.turn === me ? T : null,
    left: m.over ? 0 : Math.max(0, TURN_S * 1000 - (Date.now() - m.turnAt)),
    idle: [m.idle[me] || 0, m.idle[1 - me] || 0],
    over: !!m.over,
    result: r ? { winner: r.winner === -1 ? -1 : side(r.winner), scores: [r.scores[me], r.scores[1 - me]], why: r.why, by: r.by == null ? null : side(r.by) } : null,
    // what happened, in order; the other side's cards from the deck stay secret
    log: log.map((e, i) => ({ i, by: side(e.by), a: e.a, from: e.from, n: e.by === me ? e.secret ?? e.n : e.n, k: e.k, cards: e.cards, pts: e.pts, add: e.add })).slice(-12),
    moves: m.moves.length,
  };
}
export { RC };
