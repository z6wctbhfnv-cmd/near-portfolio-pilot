# Демо dolya: сценарий показа

Правила хакатона: «Show one complete moment. In the demo, go from a real user action to a visible result. Skip long intros, architecture slides, and setup» и «объясните роль NEAR конкретно». Пост в X должен говорить, что проект сделан на NEAR HACKATHON, отмечать `@NEARProtocol` и `#NEARHackathon` и содержать видео или скриншоты. Тексты для поста и формы лежат в [SUBMISSION.md](SUBMISSION.md).

Говорим по-английски: судьи англоязычные. Показ идёт на бумажных деньгах, с реальными ценами и NFT из тестнета NEAR. Говорим об этом прямо.

## Перед показом (10 минут)

1. `npm run dev` в корне репозитория. Сайт: http://localhost:3000.
2. Открой сайт в окне инкогнито: так портфеля ещё нет и виден чистый старт.
3. Проверь интернет: цены и NFT читаются из сети.
4. Запасной план, если сеть подвела: покажи `npm run tour` в терминале (тот же путь, 9 шагов за минуту) или готовое видео.

## Сцены (около 2,5 минуты)

| # | Время | Что делаешь | Что видно | Что говоришь (EN) |
|---|---|---|---|---|
| 1 | 0:00–0:10 | Главная страница | «Your moves. Now explained.» | "Trading bots move your money and never tell you why. And to use one, you hand over your keys. dolya fixes both." |
| 2 | 0:10–0:35 | **Rules** → вводишь `Careful: NEAR, BTC and ETH. Max $300 a day, $50 per trade.` → Continue → Looks right → Start my pilot | «Here's what we understood»: дневной лимит $300, сделка до $50, «Withdrawals: your wallet only» | "I say how my money should be handled, in plain words. dolya turns that into exact limits. In live mode I sign them once as a NEAR Intents policy: swaps only, no destination. The wallet enforces it, not our server." |
| 3 | 0:35–1:00 | **Portfolio** → Run now → открываешь сделку | «3 swaps · $150» и причина | "The strategy wanted to move three hundred dollars. My rules cap a trade at fifty, so one fifty went through, and it told me why." |
| 4 | 1:00–1:35 | **Leaderboard** → открываешь «Trend filter» → Copy into my paper portfolio | Строки с меткой on-chain, владелец, залог и комиссия из контракта | "Every strategy is an NFT on NEAR with a public record. I copy one: my agent follows it inside my own limits. Its holder earns five percent of my new profit, only above my previous peak, and has to keep a bond." |
| 5 | 1:35–1:55 | **Portfolio**: карточки Copying и Fees; в Tasks вводишь `if BTC below 100000 buy $25` → Start watching | Копирование с залогом из блокчейна, недельные комиссии, задача «watching» | "Fees are a weekly ledger above a high-water mark. And I can give it tasks in words; the backend watches the price." |
| 6 | 1:55–2:10 | В карточке стратегии: блок Buy и Offers | Цена продажи, предложения | "The NFT can be sold, or bought with an offer held in escrow. The record and the income move with it." |
| 7 | 2:10–2:20 | Freeze | Красная плашка | "One tap freezes everything." |
| 8 | 2:20–2:40 | Главная или README | Ссылки | "NEAR Intents enforces the policy. A NEAR contract holds the strategy NFTs, the fees and the bonds. Strategies are WASM, built for OutLayer's TEE. NEAR AI reads the rules and writes the weekly review. The repo has a one-minute tour you can run with no keys." |

Блок Offers в сцене 6 заработает на живом контракте после его обновления в тестнете. До этого сайт сам пишет, что предложения откроются после обновления; тогда в этой сцене покажи покупку выставленной стратегии.

## Вопросы, которые зададут

| Вопрос | Ответ (EN) |
|---|---|
| Is this live? | "Today it trades paper money on live prices. The live path is built on the official Agent API SDK and tested against a fake API; we had no partner key in time. It is off by default." |
| What stops the AI or a bug from draining the wallet? | "The policy the owner signs: swaps only, no destination, budgets. The agent wallet enforces it. The AI never trades; it proposes small parameter changes the owner can apply." |
| Why NFTs? | "They make a strategy ownable. The NFT is bound to the script's code hash, carries its weekly record and receives the copy fees. Sell the NFT and you sell the income." |
| What if the author changes the code? | "The contract restarts the record and shows a new version with the date. Copiers' agents ask their owners before following it." |
| How do creators get paid? | "Weekly, five percent of each copier's new profit above their previous peak. The contract splits it between the holder, dolya and a referrer." |
| What protects copiers? | "The holder's bond: at least a hundred dollars or one percent of copiers' capital. Below it, copying closes." |
