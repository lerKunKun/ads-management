CREATE TYPE "public"."copy_step_status" AS ENUM('pending', 'running', 'success', 'unknown', 'failed', 'skipped', 'retrying');--> statement-breakpoint
CREATE TYPE "public"."copy_workflow_phase" AS ENUM('preflight', 'create_campaign', 'create_adsets', 'create_ads', 'verify', 'repair', 'restore_status', 'done');--> statement-breakpoint
CREATE TYPE "public"."copy_workflow_status" AS ENUM('pending', 'running', 'waiting', 'success', 'partial', 'failed', 'canceled', 'paused');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operation_copy_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_item_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"parent_step_key" text,
	"new_id" text,
	"status" "copy_step_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operation_copy_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"task_item_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"fb_account_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"meta_act_id" text NOT NULL,
	"source_campaign_id" text NOT NULL,
	"new_campaign_id" text,
	"status" "copy_workflow_status" DEFAULT 'pending' NOT NULL,
	"phase" "copy_workflow_phase" DEFAULT 'preflight' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_copy_steps" ADD CONSTRAINT "operation_copy_steps_workflow_id_operation_copy_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."operation_copy_workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_copy_steps" ADD CONSTRAINT "operation_copy_steps_task_id_operation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."operation_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_copy_steps" ADD CONSTRAINT "operation_copy_steps_task_item_id_operation_task_items_id_fk" FOREIGN KEY ("task_item_id") REFERENCES "public"."operation_task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_copy_steps" ADD CONSTRAINT "operation_copy_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_copy_workflows" ADD CONSTRAINT "operation_copy_workflows_task_id_operation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."operation_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_copy_workflows" ADD CONSTRAINT "operation_copy_workflows_task_item_id_operation_task_items_id_fk" FOREIGN KEY ("task_item_id") REFERENCES "public"."operation_task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_copy_workflows" ADD CONSTRAINT "operation_copy_workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "op_copy_steps_workflow_step_idx" ON "operation_copy_steps" USING btree ("workflow_id","step_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_steps_workflow_idx" ON "operation_copy_steps" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_steps_task_idx" ON "operation_copy_steps" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_steps_company_idx" ON "operation_copy_steps" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_steps_status_idx" ON "operation_copy_steps" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "op_copy_workflows_task_item_idx" ON "operation_copy_workflows" USING btree ("task_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_workflows_task_idx" ON "operation_copy_workflows" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_workflows_company_idx" ON "operation_copy_workflows" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_workflows_status_idx" ON "operation_copy_workflows" USING btree ("status");