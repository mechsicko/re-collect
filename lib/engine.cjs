// re:collect rules engine: copied verbatim from public/index.html so the server referees with the same rules.
// If the game page changes its engine, copy it here again.
/* =====================================================================
   re:collect — rules engine
   Every card is a real re:gen. The data is the collection's own trait list:
   { types[12], values[12][], counts[12][], tokens: 12 chars per re:gen }
   '.' = no trait in that slot; a letter = index into values[slot].
   ===================================================================== */
(function (root) {
'use strict';

/* ---------- rng ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(a, R) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- the collection ---------- */
const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SLOTS = 12;
let D = null;                 // the raw data
let N = 0;                    // how many re:gens
let TR = null;                // TR[n] = [key, key, ...] for re:gen #n (playable traits only)
let ALL = null;               // ALL[n] = [[slot, valueIndex], ...] every trait, for the card face
let ARTIST = null;            // ARTIST[n] = handle for a 1 of 1
let BY_KEY = null;            // key -> [n, ...]
const key = (t, v) => t * 64 + v;
const slotOf = k => k >> 6, valOf = k => k & 63;
function init(data) {
  D = data; N = Math.floor(data.tokens.length / SLOTS);
  TR = new Array(N + 1); ALL = new Array(N + 1); ARTIST = {}; BY_KEY = new Map();
  const tArtist = data.types.indexOf('artist'), tBg = data.types.indexOf('background');
  for (let n = 1; n <= N; n++) {
    const s = data.tokens.substr((n - 1) * SLOTS, SLOTS), all = [], play = [];
    for (let t = 0; t < SLOTS; t++) {
      const ch = s[t]; if (ch === '.') continue;
      const v = CH.indexOf(ch); if (v < 0) continue;
      all.push([t, v]);
      if (t === tArtist) { ARTIST[n] = data.values[t][v]; continue; }
      const name = data.values[t][v];
      if (name === 'none') continue;                               // "no drip" isn't something you can collect
      if (t === tBg && data.counts[t][v] > N / 2) continue;         // everybody stands on g(re:)en; only punk ground counts
      const k = key(t, v); play.push(k);
      if (!BY_KEY.has(k)) BY_KEY.set(k, []);
      BY_KEY.get(k).push(n);
    }
    TR[n] = play; ALL[n] = all;
  }
  return { N, oneOfOnes: Object.keys(ARTIST).length };
}
const count = k => D.counts[slotOf(k)][valOf(k)];
const slotName = t => D.types[t];
const valueName = (t, v) => { const s = D.values[t][v].replace(/_/g, ' '); return D.types[t] === 'type' && /^\d$/.test(s) ? 'type ' + s : s; };
const label = k => valueName(slotOf(k), valOf(k));
const kind = k => slotName(slotOf(k));
const isOne = n => !!ARTIST[n];

/* ---------- points: the rarer the trait, the more it's worth ---------- */
const BANDS = [[25, 8], [60, 6], [120, 5], [250, 4], [500, 3], [900, 2], [Infinity, 1]];
const ptsOf = k => { const c = count(k); for (const [max, p] of BANDS) if (c <= max) return p; return 1; };
const ONE_PTS = 5;                         // a 1 of 1 in a set
const SIZE_BONUS = 2;                      // each card past the third
const HOME_BONUS = 1;                      // each card in a set that matches one of your own re:gens

/* ---------- the rules, in numbers ---------- */
const RULES = { deck: 48, hand: 6, faceUp: 4, take: 2, handMax: 9, minSet: 3, threads: 10 };

/* ---------- dealing: a fresh deck from all of them ---------- */
// Pick a handful of traits as threads so sets are possible, then fill with anyone at all.
function deal(R, exclude = new Set(), boost = []) {
  const keys = [...BY_KEY.keys()].filter(k => BY_KEY.get(k).length >= 5);
  const bucket = (lo, hi) => shuffle(keys.filter(k => count(k) > lo && count(k) <= hi), R);
  const threads = [...bucket(0, 120).slice(0, 3), ...bucket(120, 500).slice(0, 4), ...bucket(500, 2000).slice(0, 3)];
  const pick = new Set();
  for (const k of threads) {
    const pool = shuffle(BY_KEY.get(k).filter(n => !isOne(n) && !exclude.has(n) && !pick.has(n)), R);
    const want = 4 + Math.floor(R() * 3);
    for (const n of pool.slice(0, want)) pick.add(n);
  }
  // a few of the week's most wanted
  for (const n of shuffle(boost.filter(n => !exclude.has(n)), R).slice(0, 3)) pick.add(n);
  // one 1 of 1, now and then
  const ones = Object.keys(ARTIST).map(Number).filter(n => !exclude.has(n));
  if (ones.length && R() < .4) pick.add(ones[Math.floor(R() * ones.length)]);
  while (pick.size < RULES.deck) {
    const n = 1 + Math.floor(R() * N);
    if (!exclude.has(n) && !isOne(n)) pick.add(n);
  }
  return { deck: shuffle([...pick].slice(0, RULES.deck), R), threads };
}

/* ---------- a game ---------- */
// home = three re:gen numbers each player brings; their traits pay a little extra
function newGame(seed, homes, mods = {}) {
  const R = rng(seed);
  const exclude = new Set(homes.flat());
  const { deck, threads } = deal(R, exclude, mods.wanted ? [...mods.wanted] : []);
  const g = { seed, R, pile: deck, faceUp: [], players: homes.map((home, i) => ({ i, home, hand: [], sets: [], score: 0, collected: [] })),
    turn: 0, n: 0, lastRound: -1, over: false, log: [], threads, mods };
  for (const p of g.players) for (let k = 0; k < RULES.hand; k++) p.hand.push(g.pile.pop());
  refill(g);
  return g;
}
function refill(g) { while (g.faceUp.length < RULES.faceUp && g.pile.length) g.faceUp.push(g.pile.pop()); }
const homeKeys = p => new Set(p.home.flatMap(n => TR[n] || []));

// can these cards make (or join) a set of trait k?
function fits(n, k) { return isOne(n) || TR[n].includes(k); }
const WANTED_PTS = 3;
function setValue(k, cards, home, already = 0, mods = {}) {
  // points for adding `cards` to a set of trait k that already holds `already` cards
  let pts = 0;
  const base = ptsOf(k) * (mods.feature != null && slotOf(k) === mods.feature ? 2 : 1);
  cards.forEach((n, i) => {
    pts += isOne(n) ? ONE_PTS : base;
    if (mods.wanted && mods.wanted.has(n)) pts += WANTED_PTS;
    if (already + i >= RULES.minSet) pts += SIZE_BONUS;
    if (home.has(k)) pts += HOME_BONUS;
  });
  return pts;
}
// every trait the selected cards all share (a 1 of 1 fits anything)
function shared(cards) {
  const real = cards.filter(n => !isOne(n));
  if (!real.length) return [];
  let ks = TR[real[0]].slice();
  for (const n of real.slice(1)) ks = ks.filter(k => TR[n].includes(k));
  return ks.sort((a, b) => count(a) - count(b));
}

/* ---------- moves ---------- */
// take: up to two picks, each 'pile' or an index into faceUp (indices read before any refill)
function take(g, picks) {
  const p = g.players[g.turn], got = [];
  const fromFace = picks.filter(x => x !== 'pile').sort((a, b) => b - a);
  for (const i of fromFace) { if (g.faceUp[i] != null) { got.push(['face', g.faceUp[i]]); p.hand.push(g.faceUp[i]); g.faceUp.splice(i, 1); } }
  for (const x of picks) if (x === 'pile' && g.pile.length) { const n = g.pile.pop(); got.push(['pile', n]); p.hand.push(n); }
  refill(g);
  return got;
}
// recollect: [{k, cards, add?}] — new sets need 3+, additions join one of your sets of the same trait
function canRecollect(g, plays) {
  const p = g.players[g.turn], used = new Set();
  for (const pl of plays) {
    for (const n of pl.cards) { if (!p.hand.includes(n) || used.has(n)) return 'Those cards are not all in your hand.'; used.add(n); }
    if (!pl.cards.every(n => fits(n, pl.k))) return 'Every card has to share the trait.';
    if (pl.cards.every(isOne)) return 'A 1 of 1 needs real company.';
    const mine = p.sets.find(s => s.k === pl.k);
    if (mine) { if (!pl.cards.length) return 'Pick a card to add.'; }
    else if (pl.cards.length < RULES.minSet) return `A new set needs ${RULES.minSet} re:gens.`;
  }
  return null;
}
function recollect(g, plays) {
  const err = canRecollect(g, plays); if (err) throw new Error(err);
  const p = g.players[g.turn], home = homeKeys(p), out = [];
  for (const pl of plays) {
    let set = p.sets.find(s => s.k === pl.k);
    const already = set ? set.cards.length : 0;
    const pts = setValue(pl.k, pl.cards, home, already, g.mods);
    if (!set) { set = { k: pl.k, cards: [], pts: 0 }; p.sets.push(set); }
    set.cards.push(...pl.cards); set.pts += pts; p.score += pts;
    p.hand = p.hand.filter(n => !pl.cards.includes(n));
    p.collected.push(...pl.cards);
    out.push({ k: pl.k, cards: pl.cards.slice(), pts, add: already > 0 });
  }
  return out;
}
// what's left in hand past the limit goes face up for the other side
function discard(g, cards) {
  const p = g.players[g.turn];
  for (const n of cards) { p.hand = p.hand.filter(x => x !== n); g.faceUp.push(n); }
}
function endTurn(g) {
  g.n++;
  if (!g.pile.length && g.lastRound < 0) g.lastRound = g.n + g.players.length - 1;   // everyone gets one more turn
  if ((g.lastRound >= 0 && g.n > g.lastRound) || (!g.pile.length && !g.faceUp.length)) return finish(g);
  g.turn = (g.turn + 1) % g.players.length;
}
function finish(g) {
  g.over = true;
  for (const p of g.players) { p.left = p.hand.length; p.score -= p.hand.length; }
  const [a, b] = g.players.map(p => p.score);
  g.winner = a === b ? -1 : a > b ? 0 : 1;
}

/* ---------- the house ---------- */
// every set it could lay down right now, best first, no card used twice
function bestPlays(g, pi) {
  const p = g.players[pi], home = homeKeys(p), plays = [], used = new Set();
  for (;;) {
    let best = null;
    const free = p.hand.filter(n => !used.has(n));
    const ones = free.filter(isOne);
    const keys = new Set(free.filter(n => !isOne(n)).flatMap(n => TR[n]));
    for (const k of keys) {
      const cards = free.filter(n => !isOne(n) && TR[n].includes(k));
      const mine = p.sets.find(s => s.k === k);
      const need = mine ? 1 : RULES.minSet;
      const withOne = cards.length + ones.length >= need && cards.length >= 1 ? cards.concat(cards.length >= need ? [] : ones.slice(0, need - cards.length)) : null;
      if (!withOne || withOne.length < need) continue;
      const v = setValue(k, withOne, home, mine ? mine.cards.length : 0, g.mods);
      if (!best || v > best.v) best = { k, cards: withOne, v, add: !!mine };
    }
    if (!best) break;
    best.cards.forEach(n => used.add(n)); plays.push(best);
  }
  return plays;
}
// how much a card would help this player's hand and sets
function cardWorth(g, pi, n, hand = g.players[pi].hand) {
  if (isOne(n)) return 7;
  const p = g.players[pi], home = homeKeys(p);
  let best = 0;
  for (const k of TR[n]) {
    const inHand = hand.filter(m => m !== n && fits(m, k)).length;
    const mine = p.sets.some(s => s.k === k);
    const base = ptsOf(k) * (g.mods && g.mods.feature === slotOf(k) ? 2 : 1);
    let v = base * (mine ? 1.6 : inHand >= 2 ? 1.4 : inHand === 1 ? .8 : .15);
    if (g.mods && g.mods.wanted && g.mods.wanted.has(n)) v += 1.5;
    if (home.has(k)) v += .6;
    best = Math.max(best, v);
  }
  return best;
}
function houseTurn(g, level = 'sharp') {
  const pi = g.turn, p = g.players[pi], R = g.R;
  const plays = bestPlays(g, pi);
  const total = plays.reduce((a, x) => a + x.v, 0);
  const late = g.pile.length < 10 || g.lastRound >= 0;
  const big = plays.some(x => x.add || x.cards.length >= 4 || ptsOf(x.k) >= 4);
  const goNow = level === 'easy' ? plays.length > 0 && R() < .8
    : plays.length > 0 && (late || big || p.hand.length >= RULES.handMax - 1 || total >= 10 || !g.pile.length);
  if (goNow) { const done = recollect(g, plays.map(x => ({ k: x.k, cards: x.cards }))); endTurn(g); return { kind: 'recollect', done }; }
  // take two: the best face-up cards, or the pile
  const picks = []; const hand = p.hand.slice();
  const face = g.faceUp.map((n, i) => ({ i, n, v: cardWorth(g, pi, n, hand) + (level === 'sharp' ? .35 * cardWorth(g, 1 - pi, n, g.players[1 - pi].hand) : 0) + (level === 'easy' ? R() * 3 : 0) }));
  face.sort((a, b) => b.v - a.v);
  const PILE = level === 'easy' ? 1.2 : 1.9;   // what a blind card is worth, roughly
  for (const f of face) { if (picks.length >= RULES.take) break; if (f.v > PILE) { picks.push(f.i); hand.push(f.n); } }
  while (picks.length < RULES.take && (g.pile.length > picks.filter(x => x === 'pile').length)) picks.push('pile');
  if (!picks.length && g.faceUp.length) picks.push(face[0].i);
  const got = take(g, picks);
  let dropped = [];
  if (p.hand.length > RULES.handMax) {
    const sorted = p.hand.slice().sort((a, b) => cardWorth(g, pi, a) - cardWorth(g, pi, b));
    dropped = sorted.slice(0, p.hand.length - RULES.handMax);
    discard(g, dropped);
  }
  endTurn(g);
  return { kind: 'take', got, dropped };
}

const api = {
  rng, shuffle, init, RULES, BANDS, ONE_PTS, SIZE_BONUS, HOME_BONUS, WANTED_PTS,
  get N() { return N; }, get D() { return D; },
  traits: n => TR[n], allTraits: n => ALL[n], artist: n => ARTIST[n] || null, isOne, count, label, kind, slotName, valueName, ptsOf, key, slotOf, valOf,
  byKey: k => BY_KEY.get(k) || [], shared, fits, setValue, homeKeys,
  newGame, take, recollect, canRecollect, discard, endTurn, bestPlays, cardWorth, houseTurn,
};
if (typeof module !== 'undefined') module.exports = api; else root.RC = api;
})(this);

