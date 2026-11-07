CREATE TABLE "authors" (
	"external_id" text PRIMARY KEY NOT NULL,
	"display" text,
	"budget_id" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"spend_usd" double precision DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"next_reset_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"arm" text NOT NULL,
	"hijacked" boolean DEFAULT false NOT NULL,
	"false_block" boolean DEFAULT false NOT NULL,
	"outcome" jsonb,
	"cost_usd" double precision,
	"latency_ms" integer,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guard_verdicts" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"input_sha256" text NOT NULL,
	"profile" text NOT NULL,
	"valid" boolean NOT NULL,
	"score" double precision,
	"explanation" text,
	"signals" jsonb,
	"model_verdicts" jsonb,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"state" text NOT NULL,
	"author" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"embedding" vector(1024),
	CONSTRAINT "issues_repo_number_uq" UNIQUE("repo_id","number")
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"action" text NOT NULL,
	"args" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"execution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"repo_id" integer NOT NULL,
	"tag" text NOT NULL,
	"name" text,
	"body" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "releases_repo_id_tag_pk" PRIMARY KEY("repo_id","tag")
);
--> statement-breakpoint
CREATE TABLE "repo_files" (
	"repo_id" integer NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"sha" text,
	CONSTRAINT "repo_files_repo_id_path_pk" PRIMARY KEY("repo_id","path")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"kind" text NOT NULL,
	"installation_id" text,
	"snapshot_at" timestamp with time zone,
	CONSTRAINT "repos_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"arm" text NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer,
	"delivery_id" text,
	"author_external_id" text,
	"title" text,
	"body" text,
	"status" text NOT NULL,
	"reply" text,
	"triage" jsonb,
	"total_cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"role" text NOT NULL,
	"requested_model" text,
	"served_model" text,
	"provider" text,
	"fallback" boolean DEFAULT false NOT NULL,
	"attempt_count" integer,
	"request_id" text,
	"cost_usd" double precision,
	"duration_ms" integer,
	"guardrails" jsonb,
	"tool_calls" jsonb,
	"error_kind" text,
	"error_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_verdicts" ADD CONSTRAINT "guard_verdicts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_files" ADD CONSTRAINT "repo_files_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_repo_issue_idx" ON "runs" USING btree ("repo","issue_number");--> statement-breakpoint
CREATE INDEX "steps_run_idx" ON "steps" USING btree ("run_id");