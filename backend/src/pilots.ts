/** Pilot records: one per owner portfolio (paper, or live on an Agent API agent). */
import { randomUUID } from "node:crypto";
import { type Db, json, parse } from "./db.js";
import type { Mandate } from "./mandate.js";
import type { StrategyId } from "./strategies.js";
import type { SwarmConfig, SwarmState } from "./swarm.js";

export type PilotRow = {
  id: string;
  name: string;
  agent_id: string | null;
  status: "draft" | "pending_owner" | "active" | "paused" | "frozen" | "archived";
  mode: "paper" | "live";
  owner_json: string | null;
  mandate_json: string | null;
  policy_json: string | null;
  strategy_id: StrategyId;
  strategy_params_json: string;
  strategy_state_json: string;
  paper_holdings_json: string | null;
  review_auto_apply: number;
  next_run_at: number | null;
  next_review_at: number | null;
  /** The drawdown stop measures the peak from here (creation, or the owner's last resume). */
  risk_since: number | null;
  swarm_json: string | null;
  swarm_state_json: string | null;
  created_at: number;
  updated_at: number;
};

export type Pilot = ReturnType<typeof view>;

export function view(r: PilotRow) {
  return {
    id: r.id,
    name: r.name,
    agent_id: r.agent_id,
    status: r.status,
    mode: r.mode,
    owner: parse(r.owner_json, null),
    mandate: parse<Mandate | null>(r.mandate_json, null),
    policy: parse(r.policy_json, null),
    strategy: { id: r.strategy_id, params: parse<Record<string, unknown>>(r.strategy_params_json, {}), state: parse(r.strategy_state_json, {}) },
    paper_holdings: parse<Record<string, number> | null>(r.paper_holdings_json, null),
    review_auto_apply: Boolean(r.review_auto_apply),
    next_run_at: r.next_run_at,
    next_review_at: r.next_review_at,
    risk_since: r.risk_since,
    swarm: parse<SwarmConfig | null>(r.swarm_json, null),
    swarm_state: parse<SwarmState | null>(r.swarm_state_json, null),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class Pilots {
  constructor(private readonly db: Db) {}

  async create(input: {
    name: string;
    mode: "paper" | "live";
    status: PilotRow["status"];
    owner?: unknown;
    mandate?: Mandate | null;
    policy?: unknown;
    strategy: { id: StrategyId; params: Record<string, unknown> };
    paper_holdings?: Record<string, number> | null;
    review_auto_apply?: boolean;
    review_every_days: number;
  }) {
    const id = randomUUID();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO pilots (id, name, agent_id, status, mode, owner_json, mandate_json, policy_json, strategy_id, strategy_params_json,
          strategy_state_json, paper_holdings_json, review_auto_apply, next_run_at, next_review_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.status,
        input.mode,
        json(input.owner ?? null),
        json(input.mandate ?? null),
        json(input.policy ?? null),
        input.strategy.id,
        json(input.strategy.params)!,
        json(input.paper_holdings ?? null),
        input.review_auto_apply ? 1 : 0,
        now,
        now + input.review_every_days * 86_400_000,
        now,
        now,
      );
    return (await this.get(id))!;
  }

  row(id: string) {
    return this.db.prepare("SELECT * FROM pilots WHERE id = ?").get<PilotRow>(id);
  }

  async get(id: string) {
    const r = await this.row(id);
    return r ? view(r) : undefined;
  }

  async byAgent(agentId: string) {
    const r = await this.db.prepare("SELECT * FROM pilots WHERE agent_id = ?").get<PilotRow>(agentId);
    return r ? view(r) : undefined;
  }

  async list() {
    return (await this.db.prepare("SELECT * FROM pilots ORDER BY created_at DESC").all<PilotRow>()).map(view);
  }

  async due(now = Date.now()) {
    return (
      await this.db
        .prepare("SELECT * FROM pilots WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at")
        .all<PilotRow>(now)
    ).map(view);
  }

  async dueReviews(now = Date.now()) {
    return (
      await this.db
        .prepare("SELECT * FROM pilots WHERE status IN ('active','frozen') AND next_review_at IS NOT NULL AND next_review_at <= ?")
        .all<PilotRow>(now)
    ).map(view);
  }

  async update(id: string, fields: Partial<Omit<PilotRow, "id" | "created_at">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return this.get(id);
    await this.db
      .prepare(`UPDATE pilots SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null), Date.now(), id);
    return this.get(id);
  }
}
