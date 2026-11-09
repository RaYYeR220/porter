import heroJson from "./hero-data.json";

/** A run of payload characters and whether it is invisible in the rendered issue. */
export type PayloadRun = [text: string, hidden: boolean];

export type HeroAttack = {
  /** Eval corpus case id. */
  id: string;
  /** The detector signal that holds this text at the gateway. */
  signal: string;
  /** First words of the case title. */
  lead: string;
  payload: PayloadRun[];
};

export type HeroData = {
  source: { repo: string; snapshotAt: string | null };
  /** Open issues of the source repo: number and title, never the author. */
  issues: Array<[number, string]>;
  attacks: HeroAttack[];
  /** Issue titles of the /try spam preset: one author filing twelve issues. */
  spam: string[];
};

export const heroData = heroJson as HeroData;

/**
 * Facts the labels state. All are configuration, not measurements:
 * the porter-triage routing policy serves DeepSeek V4.1 Flash and moves an author to DeepSeek V4 Flash from 80% of
 * their budget; end-user budgets reset daily at UTC midnight; a gateway hold never reaches the answering
 * model, so it spends no answer tokens (the guard's own classifiers still run).
 */
export const FACTS = {
  triageModel: "deepseek-v4.1-flash",
  tierDownModel: "deepseek-v4-flash",
  tierDownAt: "≥80%",
  resets: "00:00 UTC",
} as const;
