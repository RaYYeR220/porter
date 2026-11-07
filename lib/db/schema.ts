import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const repos = pgTable("repos", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull().unique(),
  kind: text("kind", { enum: ["demo", "shadow"] }).notNull(),
  installationId: text("installation_id"),
  snapshotAt: ts("snapshot_at"),
}, (t) => [check("repos_kind_chk", sql`${t.kind} in ('demo','shadow')`)]);

export const issues = pgTable(
  "issues",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull(),
    author: text("author"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    createdAt: ts("created_at"),
    closedAt: ts("closed_at"),
    embedding: vector("embedding", { dimensions: 1024 }),
  },
  (t) => [unique("issues_repo_number_uq").on(t.repoId, t.number)],
);

export const repoFiles = pgTable(
  "repo_files",
  {
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    sha: text("sha"),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.path] })],
);

export const releases = pgTable(
  "releases",
  {
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    name: text("name"),
    body: text("body"),
    publishedAt: ts("published_at"),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.tag] })],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source", { enum: ["github", "web", "eval", "shadow"] }).notNull(),
    arm: text("arm", { enum: ["porter", "baseline"] }).notNull(),
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number"),
    deliveryId: text("delivery_id").unique(),
    authorExternalId: text("author_external_id"),
    title: text("title"),
    body: text("body"),
    status: text("status").notNull(),
    reply: text("reply"),
    triage: jsonb("triage"),
    totalCostUsd: doublePrecision("total_cost_usd").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("runs_repo_issue_idx").on(t.repo, t.issueNumber),
    check("runs_source_chk", sql`${t.source} in ('github','web','eval','shadow')`),
    check("runs_arm_chk", sql`${t.arm} in ('porter','baseline')`),
  ],
);

export const steps = pgTable(
  "steps",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    requestedModel: text("requested_model"),
    servedModel: text("served_model"),
    provider: text("provider"),
    fallback: boolean("fallback").notNull().default(false),
    attemptCount: integer("attempt_count"),
    requestId: text("request_id"),
    costUsd: doublePrecision("cost_usd"),
    durationMs: integer("duration_ms"),
    guardrails: jsonb("guardrails"),
    toolCalls: jsonb("tool_calls"),
    errorKind: text("error_kind"),
    errorStatus: integer("error_status"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("steps_run_idx").on(t.runId)],
);

export const guardVerdicts = pgTable("guard_verdicts", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  inputSha256: text("input_sha256").notNull(),
  profile: text("profile").notNull(),
  valid: boolean("valid").notNull(),
  score: doublePrecision("score"),
  explanation: text("explanation"),
  signals: jsonb("signals"),
  modelVerdicts: jsonb("model_verdicts"),
  latencyMs: integer("latency_ms"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const proposals = pgTable("proposals", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  action: text("action", { enum: ["add_labels", "close_as_duplicate"] }).notNull(),
  args: jsonb("args").notNull(),
  status: text("status", { enum: ["pending", "executed", "rejected", "failed"] }).notNull().default("pending"),
  decidedBy: text("decided_by"),
  execution: jsonb("execution"),
  createdAt: ts("created_at").notNull().defaultNow(),
  decidedAt: ts("decided_at"),
}, (t) => [
  check("proposals_action_chk", sql`${t.action} in ('add_labels','close_as_duplicate')`),
  check("proposals_status_chk", sql`${t.status} in ('pending','executed','rejected','failed')`),
]);

export const authors = pgTable("authors", {
  externalId: text("external_id").primaryKey(),
  display: text("display"),
  budgetId: text("budget_id"),
  blocked: boolean("blocked").notNull().default(false),
  spendUsd: doublePrecision("spend_usd").notNull().default(0),
  requests: integer("requests").notNull().default(0),
  nextResetAt: ts("next_reset_at"),
  refreshedAt: ts("refreshed_at"),
});

export const evalResults = pgTable("eval_results", {
  id: serial("id").primaryKey(),
  caseId: text("case_id").notNull(),
  arm: text("arm", { enum: ["porter", "baseline"] }).notNull(),
  hijacked: boolean("hijacked").notNull().default(false),
  falseBlock: boolean("false_block").notNull().default(false),
  outcome: jsonb("outcome"),
  costUsd: doublePrecision("cost_usd"),
  latencyMs: integer("latency_ms"),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [check("eval_results_arm_chk", sql`${t.arm} in ('porter','baseline')`)]);

export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  expiresAt: ts("expires_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
