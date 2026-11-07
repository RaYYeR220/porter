ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_arm_chk" CHECK ("eval_results"."arm" in ('porter','baseline'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_action_chk" CHECK ("proposals"."action" in ('add_labels','close_as_duplicate'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_status_chk" CHECK ("proposals"."status" in ('pending','executed','rejected','failed'));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_kind_chk" CHECK ("repos"."kind" in ('demo','shadow'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_source_chk" CHECK ("runs"."source" in ('github','web','eval','shadow'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_arm_chk" CHECK ("runs"."arm" in ('porter','baseline'));