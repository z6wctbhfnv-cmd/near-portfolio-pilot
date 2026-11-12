// Deployment settings. The site is static; live actions need the Pilot backend (holds the Agent API key).
export const CONFIG = {
  // Base URL of the Pilot backend, e.g. "https://api.example.com". null = simulation-only site.
  apiBase: null,
  // Owners allowed to use real funds at launch: NEAR account ids or passkey credential ids.
  allowlist: [],
  // Strategy NFT contract (one NFT per script). contract: null = show simulation data only.
  nft: {
    contract: "pilot-nft2-14805.testnet",
    rpc: "https://test.rpc.fastnear.com",
    explorer: "https://testnet.nearblocks.io/address",
    feeToken: "usdc.fakes.testnet",
  },
  repoUrl: "https://github.com/z6wctbhfnv-cmd/near-portfolio-pilot",
};
