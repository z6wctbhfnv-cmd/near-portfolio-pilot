# Disclaimer / Отказ от ответственности

> Draft for the hackathon build. Not reviewed by a lawyer. Get a legal review before any public launch.
> Черновик для хакатона. Юрист его не проверял. Перед публичным запуском нужна юридическая проверка.

## English

**Prototype.** NEAR Portfolio Pilot is an experimental prototype built for the NEAR Hackathon (November 2026). The code is unaudited. Use it only with amounts you can afford to lose completely.

**Not advice.** Nothing in this software, its interface, its reports or its AI output is investment, financial, legal or tax advice, or a recommendation to buy, sell or hold any asset.

**No guarantee of results.** Returns are not guaranteed. Simulations and backtests are hypothetical and are not real results. A strategy's verified on-chain history describes the past only and does not predict future results.

**You can lose everything.** Risks include, among others:

- market moves, volatility and liquidity gaps;
- slippage, solver spreads and fees on every swap;
- failures, exploits or downtime of third-party systems: NEAR Intents and its solvers, bridges, the Agent API, OutLayer, NEAR AI Cloud, vault protocols and curators;
- stablecoin or tokenized-asset de-pegs;
- stale or wrong price data;
- bugs in this software.

**Non-custodial.** Funds stay in your own agent wallet. The agent acts only inside the policy you sign: limits, budget, allowed destinations, freeze. We never hold your keys. If you lose access to the owner wallet or passkey, nobody can change the agent's rules or recover it, including us and the Agent API.

**AI can be wrong.** The AI reviewer can misread data or make poor decisions. The signed policy limits what it can do, but it can still lose money inside those limits.

**Your responsibility.** You are responsible for:

- making sure using this software is legal where you live (some products, such as perpetual futures or tokenized securities, are not available in certain countries, including the US and Canada);
- sanctions compliance;
- your taxes.

**As is.** The software is provided "as is", without warranty of any kind, under the licenses in this repository: MIT for `strategies/` and `contracts/` (see the `LICENSE` file in each), Apache-2.0 for everything else (`LICENSE` at the root). To the maximum extent the law allows, the authors are not liable for any loss.

## Русский

**Прототип.** NEAR Portfolio Pilot — экспериментальный прототип, сделанный для NEAR Hackathon (ноябрь 2026). Код не проходил аудит. Используйте его только с суммами, которые готовы полностью потерять.

**Это не совет.** Ничто в программе, её интерфейсе, отчётах и ответах AI не является инвестиционной, финансовой, юридической или налоговой консультацией или рекомендацией покупать, продавать или держать какой-либо актив.

**Результат не гарантирован.** Доходность не гарантируется. Симуляции и бэктесты гипотетические и не являются реальными результатами. Проверенная история сделок стратегии описывает только прошлое и не предсказывает будущее.

**Можно потерять всё.** Среди рисков:

- движения рынка, волатильность и провалы ликвидности;
- проскальзывание, спред решателей и комиссии на каждом обмене;
- сбои, взломы и простои сторонних систем: NEAR Intents и решателей, мостов, Agent API, OutLayer, NEAR AI Cloud, протоколов и кураторов ваултов;
- потеря привязки стейблкоинов и токенизированных активов;
- устаревшие или неверные цены;
- ошибки в этой программе.

**Без кастодиана.** Деньги лежат в вашем собственном кошельке агента. Агент действует только в рамках подписанной вами политики: лимиты, бюджет, разрешённые адреса, заморозка. Мы не храним ваши ключи. Если вы потеряете доступ к кошельку или passkey владельца, изменить правила агента или восстановить его не сможет никто — ни мы, ни Agent API.

**AI может ошибаться.** AI-ревизор может неверно понять данные или принять плохое решение. Подписанная политика ограничивает его действия, но в этих пределах деньги всё равно можно потерять.

**Ваша ответственность.** Вы сами отвечаете за то, чтобы:

- пользоваться программой законно там, где вы живёте (некоторые продукты, например бессрочные фьючерсы или токенизированные ценные бумаги, недоступны в ряде стран, включая США и Канаду);
- соблюдать санкции;
- платить налоги.

**Как есть.** Программа предоставляется «как есть», без каких-либо гарантий, по лицензии этого репозитория. В максимальной степени, допустимой законом, авторы не несут ответственности за убытки.
