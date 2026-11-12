# Dolya frontend

Next.js 15 app for NEAR Portfolio Pilot, branded **dolya**. It talks to the Pilot backend in `../backend`.

```bash
npm install
npm run dev            # http://localhost:3000
```

Start the backend in another terminal (`cd ../backend && npm start`, port 8787). Point the app at another backend with `NEXT_PUBLIC_API_BASE=https://…`.

## What talks to what

| Screen | Backend |
|---|---|
| Rules (`/start`) | `POST /v1/mandate/parse`, then `POST /v1/pilots` (paper) |
| Portfolio (`/dashboard`) | pilot, portfolio, runs, snapshots, reviews; Run now, Freeze/Resume (`PATCH paused`), Review now |
| Strategies (`/strategies`) | `GET /v1/strategies`, a 90-day `backtest` per card, `PUT /v1/pilots/:id/strategy` |
| Connect wallet | NEAR wallet selector (Meteor, HERE, Intear, MyNearWallet), mainnet |

The pilot this browser follows is kept in `localStorage` (`dolya.pilot`). With no pilot, or with the backend offline, the screens show demo data and say so.

Not wired yet: live pilots (the wallet has to sign `owner_action.intent`), deposits, the NFT record view, and the NEAR AI "ask" screen from `../web`.

## Brand assets

- Headings and logo use **RoadRadio**. It is not on a font CDN: put `RoadRadio-Bold.woff2` in `public/fonts/`. Until then Unbounded is used.
- The 3D objects in `public/3d/` are rendered by the dev-only page `/studio` (three.js) and saved through `/api/save`. To add one, write a builder in `app/studio/page.tsx` and open `/studio?only=<name>`.
- Token icons in `public/tokens/` come from `cryptocurrency-icons` and `@web3icons/core`.
