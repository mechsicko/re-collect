// Wallet sign-in for re:collect: check a signed message, and find the re:gens a wallet holds.
// Held means in the wallet, or staked: the wallet made the latest deposit of it into a vault
// listed in REGEN_VAULTS and it hasn't left that vault since (same rule as re:informant).
import { createPublicClient, http, recoverMessageAddress, getAddress, isAddress } from 'viem';
import { base } from 'viem/chains';

export const CONTRACT = '0x26c42724eba22f2d1a2ac5d35b0344bf2f3f8188';
const KEY = () => process.env.ALCHEMY_API_KEY || '';
const rpcUrl = () => `https://base-mainnet.g.alchemy.com/v2/${KEY()}`;
const nftUrl = () => `https://base-mainnet.g.alchemy.com/nft/v3/${KEY()}`;
export const walletReady = () => !!KEY();

// "staked:0xabc…,borrowed:0xdef…" or just "0xabc…,0xdef…"
export function vaults() {
  return String(process.env.REGEN_VAULTS || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(s => { const [a, b] = s.includes(':') ? s.split(':') : ['staked', s]; return { where: a.trim().toLowerCase(), address: (b || '').trim().toLowerCase() }; })
    .filter(v => isAddress(v.address));
}

// EOA signatures are checked right here; smart wallets (Coinbase and friends) are asked on Base
export async function verify(address, message, signature) {
  try {
    const rec = await recoverMessageAddress({ message, signature });
    if (rec.toLowerCase() === address.toLowerCase()) return true;
  } catch {}
  if (!walletReady()) return false;
  try {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl()) });
    return await client.verifyMessage({ address: getAddress(address), message, signature });
  } catch { return false; }
}

async function rpc(method, params) {
  const r = await fetch(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Alchemy error');
  return j.result;
}
const tokenNum = t => { const v = t.erc721TokenId || t.tokenId || (t.rawContract && t.rawContract.tokenId); if (!v) return null; const n = Number(BigInt(v)); return n >= 1 && n <= 6666 ? n : null; };
async function ownedBy(owner) {
  const out = []; let pageKey = '';
  for (let i = 0; i < 80; i++) {
    const u = `${nftUrl()}/getNFTsForOwner?owner=${owner}&contractAddresses[]=${CONTRACT}&withMetadata=false&pageSize=100${pageKey ? '&pageKey=' + encodeURIComponent(pageKey) : ''}`;
    const j = await (await fetch(u)).json();
    for (const n of j.ownedNfts || []) { const t = Number(n.tokenId); if (t >= 1 && t <= 6666) out.push(t); }
    if (!j.pageKey) break; pageKey = j.pageKey;
  }
  return out;
}
async function transfers(filter) {
  const out = []; let pageKey;
  for (let i = 0; i < 20; i++) {
    const res = await rpc('alchemy_getAssetTransfers', [{ ...filter, contractAddresses: [CONTRACT], category: ['erc721'], order: 'desc', withMetadata: false, excludeZeroValue: false, maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}) }]);
    out.push(...(res.transfers || []));
    if (!res.pageKey) break; pageKey = res.pageKey;
  }
  return out;
}
export async function holdings(address) {
  const addr = address.toLowerCase(), out = new Map();
  for (const t of await ownedBy(addr)) out.set(t, 'wallet');
  for (const v of vaults()) {
    const inVault = new Set(await ownedBy(v.address));
    if (!inVault.size) continue;
    const mine = await transfers({ fromAddress: addr, toAddress: v.address });
    const candidates = new Map();                               // token -> block of this wallet's latest deposit
    for (const t of mine) { const n = tokenNum(t); if (n && inVault.has(n) && !candidates.has(n)) candidates.set(n, parseInt(t.blockNum, 16)); }
    if (!candidates.size) continue;
    // someone else deposited it later? then it isn't this wallet's any more
    const minBlock = Math.min(...candidates.values());
    const later = await transfers({ toAddress: v.address, fromBlock: '0x' + minBlock.toString(16) });
    for (const t of later) { const n = tokenNum(t); if (!candidates.has(n)) continue; if ((t.from || '').toLowerCase() !== addr && parseInt(t.blockNum, 16) > candidates.get(n)) candidates.delete(n); }
    for (const n of candidates.keys()) if (!out.has(n)) out.set(n, v.where);
  }
  return [...out].map(([id, where]) => ({ id, where })).sort((a, b) => a.id - b.id);
}
