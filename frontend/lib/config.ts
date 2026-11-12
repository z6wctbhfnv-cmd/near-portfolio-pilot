// Where the strategy NFTs live. The contract is on testnet for the hackathon; override with env to move it.
export const NFT = {
  contract: process.env.NEXT_PUBLIC_NFT_CONTRACT ?? "pilot-nft2-14805.testnet",
  network: (process.env.NEXT_PUBLIC_NFT_NETWORK ?? "testnet") as "testnet" | "mainnet",
  rpc: process.env.NEXT_PUBLIC_NFT_RPC ?? "https://test.rpc.fastnear.com",
  explorer: process.env.NEXT_PUBLIC_NFT_EXPLORER ?? "https://testnet.nearblocks.io",
  /** Fees and bonds are paid in this token (6 decimals). */
  feeToken: process.env.NEXT_PUBLIC_NFT_FEE_TOKEN ?? "usdc.fakes.testnet",
};

/** Mainnet RPC, used only to read the owner's public keys before a live pilot. */
export const MAINNET_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";

/** The Agent API's required risk notice, word for word as the backend sends it (backend/src/server.ts RISK_NOTICE). */
export const RISK_NOTICE =
  "The Agent API is an experimental, mainnet-only beta. You and your users may lose all assets used with it, or lose access to them. It is operated by NEAR Technologies Limited. NEAR Portfolio Pilot is an unaudited hackathon prototype; read DISCLAIMER.md.";

export const explorerAccount = (a: string) => `${NFT.explorer}/address/${encodeURIComponent(a)}`;
