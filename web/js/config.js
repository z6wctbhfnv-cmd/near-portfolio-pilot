// Deployment settings. The site is static; live actions need the Pilot backend (holds the Agent API key).
export const CONFIG = {
  // Base URL of the Pilot backend, e.g. "https://api.example.com". null = simulation-only site.
  apiBase: null,
  // Owners allowed to use real funds at launch: NEAR account ids or passkey credential ids.
  allowlist: [],
  repoUrl: "https://github.com/z6wctbhfnv-cmd/near-portfolio-pilot",
};
