// local test: serves public/ and the api, with an in-memory stand-in for Upstash
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const mem = { h: {}, k: {} };
process.env.UPSTASH_REDIS_REST_URL ||= 'http://memory';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'x';
const realFetch = globalThis.fetch;
// FAKE_CHAIN=1 answers Alchemy with made-up holdings (FAKE_HOLD="0xabc…:12+345") so sign-in can be tried offline
if (process.env.FAKE_CHAIN) process.env.ALCHEMY_API_KEY ||= 'fake';
const fakeHold = Object.fromEntries(String(process.env.FAKE_HOLD || '').split(',').filter(Boolean).map(s => { const [a, t] = s.split(':'); return [a.toLowerCase(), t.split('+').map(Number)]; }));
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (process.env.FAKE_CHAIN && url.includes('g.alchemy.com')) {
    let body = {};
    if (url.includes('/getNFTsForOwner')) { const o = new URL(url).searchParams.get('owner').toLowerCase(); body = { ownedNfts: (fakeHold[o] || []).map(t => ({ tokenId: String(t) })) }; }
    else { const q = JSON.parse(opts.body); body = { jsonrpc: '2.0', id: 1, result: q.method === 'alchemy_getAssetTransfers' ? { transfers: [] } : null }; }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }
  if (url !== 'http://memory') return realFetch(url, opts);
  const [c, ...a] = JSON.parse(opts.body); let result = null;
  const H = k => (mem.h[k] ||= {});
  const live = k => { const e = mem.k[k]; if (e && typeof e === 'object' && e.exp <= Date.now()) { delete mem.k[k]; return undefined; } return e; };
  const val = e => e && typeof e === 'object' ? e.v : e;
  switch (c) {
    case 'HSETNX': result = a[1] in H(a[0]) ? 0 : (H(a[0])[a[1]] = a[2], 1); break;
    case 'HGET': result = H(a[0])[a[1]] ?? null; break;
    case 'HSET': H(a[0])[a[1]] = a[2]; result = 1; break;
    case 'HGETALL': result = Object.entries(H(a[0])).flat(); break;
    case 'HDEL': result = 0; for (const f of a.slice(1)) if (f in H(a[0])) { delete H(a[0])[f]; result++; } break;
    case 'GET': result = val(live(a[0])) ?? null; break;
    case 'GETDEL': result = val(live(a[0])) ?? null; delete mem.k[a[0]]; break;
    case 'DEL': result = (live(a[0]) !== undefined || a[0] in mem.h) ? 1 : 0; delete mem.k[a[0]]; delete mem.h[a[0]]; break;
    case 'EXPIRE': result = 1; break;
    case 'SET': {
      const has = live(a[0]) !== undefined;
      if ((a.includes('NX') && has) || (a.includes('XX') && !has)) { result = null; break; }
      const ex = a.indexOf('EX'), px = a.indexOf('PX');
      mem.k[a[0]] = ex > 0 ? { v: a[1], exp: Date.now() + 1000 * a[ex + 1] } : px > 0 ? { v: a[1], exp: Date.now() + +a[px + 1] } : a[1];
      result = 'OK'; break;
    }
  }
  return new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
};
const api = await import('../api/recollect.js');
const versus = await import('../api/versus.js');
const PREFIX = process.env.PREFIX || '';          // e.g. /recollect to act like the page lives in a folder
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : url.pathname;
  if (path === '/api/recollect' || path === '/api/versus') {
    const body = req.method === 'POST' ? await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); }) : undefined;
    const r = await (path === '/api/versus' ? versus : api)[req.method](new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
  }
  if (path === '/' || path === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(new URL('../public/index.html', import.meta.url))); return; }
  res.writeHead(404); res.end('not found');
}).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000) + PREFIX + '/'));
