import { describe, expect, it } from "vitest";
import { compilePolicy, parseMandateRules, strategyForMandate } from "../src/mandate.js";
import { REVIEW_TUNABLE } from "../src/strategies.js";
import { ruleReview, sanitizeProposals } from "../src/review.js";
import { fromAtomic, toAtomic, usdToAtomic } from "../src/tokens.js";
import { SecretBox } from "../src/secrets.js";
import { DEFAULT_UNIVERSE } from "../src/tokens.js";

describe("atomic amounts", () => {
  it("round-trips exact decimals", () => {
    expect(toAtomic("1.5", 24)).toBe(1_500_000_000_000_000_000_000_000n);
    expect(fromAtomic(1_500_000_000_000_000_000_000_000n, 24)).toBe("1.5");
    expect(fromAtomic("1", 6)).toBe("0.000001");
    expect(toAtomic("0.1234567", 6)).toBe(123_456n); // rounds down
  });
  it("converts USD at a price", () => {
    expect(usdToAtomic(100, 4, 24)).toBe(25n * 10n ** 24n);
    expect(usdToAtomic(10, 70_000, 8)).toBe(14_285n);
    expect(usdToAtomic(0, 1, 6)).toBe(0n);
  });
  it("rejects garbage", () => {
    expect(() => toAtomic("-1", 6)).toThrow();
    expect(() => toAtomic("1e3", 6)).toThrow();
  });
});

describe("mandate from plain words", () => {
  it("reads an English instruction", () => {
    const { mandate } = parseMandateRules("Be conservative. Mostly NEAR and bitcoin, max $500 a day, no more than $50 per trade, ask me to approve.");
    expect(mandate.risk).toBe("low");
    expect(mandate.assets).toEqual(["NEAR", "BTC"]);
    expect(mandate.budget.daily_usd).toBe(500);
    expect(mandate.max_trade_usd).toBe(50);
    expect(mandate.owner_approval).toBe(true);
  });

  it("reads a Russian instruction with weights", () => {
    const { mandate } = parseMandateRules("Агрессивно: 40% NEAR, 30% эфир, остальное в USDT. Не больше 200$ в день, по будням.");
    expect(mandate.risk).toBe("high");
    expect(mandate.stable).toBe("USDT");
    expect(mandate.budget.daily_usd).toBe(200);
    expect(mandate.schedule?.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(mandate.strategy?.id).toBe("rebalance");
    expect(mandate.strategy?.params).toEqual({ weights: { NEAR: 0.4, ETH: 0.3 } });
  });

  it("recognises DCA", () => {
    const { mandate } = parseMandateRules("DCA $25 every week into NEAR and SOL");
    expect(mandate.strategy?.id).toBe("dca");
    expect(mandate.strategy?.params).toMatchObject({ amount_usd: 25, every_days: 7, buy: { NEAR: 0.5, SOL: 0.5 } });
  });

  it("picks a default strategy by risk level", () => {
    const low = strategyForMandate(parseMandateRules("conservative NEAR BTC").mandate);
    expect(low.id).toBe("rebalance");
    expect((low.params.weights as Record<string, number>).NEAR).toBeCloseTo(0.15);
    expect(strategyForMandate(parseMandateRules("NEAR").mandate).id).toBe("trend");
    expect(strategyForMandate(parseMandateRules("aggressive NEAR").mandate).id).toBe("vol_target");
  });

  it("compiles to a swaps-only policy that keeps funds inside the account", () => {
    const { mandate } = parseMandateRules("NEAR and BTC, $100 a day, $40 per trade");
    const tokens = DEFAULT_UNIVERSE.map((u) => ({ asset_id: u.asset_id, symbol: u.symbol, decimals: u.symbol === "NEAR" ? 24 : u.symbol === "BTC" ? 8 : 6, blockchain: "near", price: u.symbol === "NEAR" ? 4 : u.symbol === "BTC" ? 80_000 : 1 }));
    const { policy, warnings } = compilePolicy(mandate, tokens);
    expect(policy.actions).toEqual(["swap"]);
    expect(policy.destinations).toEqual({ mode: "only", list: [] });
    expect(policy.confidential).toBe(false);
    expect(policy.budget.daily_usd).toBe("100.00");
    const near = DEFAULT_UNIVERSE.find((u) => u.symbol === "NEAR")!.asset_id;
    expect(policy.assets).toContain(near);
    expect(policy.limits.per_transaction?.[near]).toBe((20n * 10n ** 24n).toString()); // 2 × $40 at $4
    expect(warnings).toEqual([]);
  });
});

describe("review guard rails", () => {
  const params = { stable: "USDC", band: 0.05, min_trade_usd: 5, max_turnover: 1, every_hours: 24, weights: { NEAR: 0.5 }, sma_days: 50, off_fraction: 0.25 };

  it("clamps proposals to ±25% and rejects non-tunable params", () => {
    const r = sanitizeProposals("trend", params, [
      { param: "sma_days", value: 200, reason: "slower" },
      { param: "weights", value: 1, reason: "all in" },
      { param: "min_trade_usd", value: 1, reason: "x" },
      { param: "off_fraction", value: 0.2, reason: "safer" },
    ]);
    expect(r.accepted).toEqual([
      { param: "sma_days", from: 50, to: 63, reason: "slower" },
      { param: "off_fraction", from: 0.25, to: 0.2, reason: "safer" },
    ]);
    expect(r.rejected.map((x) => x.param)).toEqual(["weights", "min_trade_usd"]);
    expect(REVIEW_TUNABLE.trend).not.toContain("weights");
  });

  it("rule reviewer cuts risk after a deep drawdown", () => {
    const r = ruleReview("trend", params, {
      period_days: 7, start_usd: 1000, end_usd: 800, return_pct: -20, max_drawdown_pct: 22, runs: 7, run_errors: 0,
      trades_filled: 3, trades_blocked: 0, blocked_reasons: {}, turnover_usd: 300, market_change_pct: {},
    });
    expect(r.proposals).toEqual([{ param: "off_fraction", value: 0.2, reason: expect.any(String) }]);
    expect(r.risk_flags[0]).toContain("drawdown");
  });
});

describe("secret box", () => {
  it("seals and opens; wrong key fails", () => {
    const a = new SecretBox("k1");
    const sealed = a.seal("ngt_secret");
    expect(sealed).not.toContain("ngt_secret");
    expect(a.open(sealed)).toBe("ngt_secret");
    expect(() => new SecretBox("k2").open(sealed)).toThrow();
  });
});

describe("AI mandate parsing", () => {
  it("treats null fields from the model as not stated", async () => {
    const { parseMandate } = await import("../src/mandate.js");
    const { mandate: rules } = parseMandateRules("Careful: NEAR and BTC, max $300 a day, $50 per trade");
    const ai = {
      configured: true,
      model: "fake",
      chatJson: async () => ({ ...rules, max_trade_usd: null, drawdown_stop: null, risk: "low" }),
    };
    const r = await parseMandate("Careful: NEAR and BTC, max $300 a day, $50 per trade", ai as never);
    expect(r.source).toBe("ai");
    expect(r.mandate.max_trade_usd).toBe(50);
  });
});
