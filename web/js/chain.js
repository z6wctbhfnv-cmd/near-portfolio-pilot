// Read-only views of the strategy NFT contract over NEAR JSON-RPC. No wallet, no keys.
import { CONFIG } from "./config.js";

const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));

export async function view(method, args = {}) {
  const { contract, rpc } = CONFIG.nft;
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "pilot", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: b64(args) } }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(j.error?.data || j.result?.error || "rpc error");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}

// On-chain facts for each script id: holder, code hash, record length, followers, fees earned.
export async function scriptsOnChain(ids) {
  if (!CONFIG.nft?.contract) return {};
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const info = await view("strategy_info", { token_id: id });
      if (!info) return;
      const [holder, record, followers, fees, price, hidden, version, fee, params, bond] = await Promise.all([
        view("revenue_receiver", { token_id: id }),
        view("record", { token_id: id, from_index: 0, limit: 200 }),
        view("follower_count", { token_id: id }),
        CONFIG.nft.feeToken ? view("fees_earned", { token_id: id, fee_token: CONFIG.nft.feeToken }) : Promise.resolve("0"),
        view("sale_price", { token_id: id }).catch(() => null),
        view("is_hidden", { token_id: id }).catch(() => false),
        view("script_version", { token_id: id }).catch(() => [1, 0]),
        view("copy_fee", { token_id: id }).catch(() => [500, 0, 0]),
        view("open_params", { token_id: id }).catch(() => "[]"),
        view("bond_status", { token_id: id }).catch(() => ["0", "100000000"]),
      ]);
      out[id] = { info, holder, record, followers, fees, price, hidden, version: version[0], changedAt: version[1],
        fee: { bps: fee[0], next: fee[1], at: fee[2] }, openParams: (() => { try { return JSON.parse(params); } catch { return []; } })(),
        bond: { held: Number(bond[0]) / 1e6, required: Number(bond[1]) / 1e6 } };
    } catch (e) {
      out[id] = { error: String(e.message || e) };
    }
  }));
  return out;
}

export const explorer = (account) => `${CONFIG.nft.explorer}/${encodeURIComponent(account)}`;
