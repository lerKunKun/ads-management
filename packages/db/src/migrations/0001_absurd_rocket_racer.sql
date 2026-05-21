CREATE TYPE "public"."ad_object_status" AS ENUM('ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."ad_object_sync_status" AS ENUM('idle', 'success', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_account_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"parent_meta_id" text DEFAULT '' NOT NULL,
	"status" "ad_object_sync_status" DEFAULT 'idle' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"meta_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "ad_object_status" DEFAULT 'PAUSED' NOT NULL,
	"effective_status" text,
	"objective" text,
	"daily_budget" integer,
	"lifetime_budget" integer,
	"start_time" timestamp with time zone,
	"stop_time" timestamp with time zone,
	"meta_created_time" timestamp with time zone,
	"meta_updated_time" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"campaign_meta_id" text,
	"adset_meta_id" text NOT NULL,
	"meta_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "ad_object_status" DEFAULT 'PAUSED' NOT NULL,
	"effective_status" text,
	"creative_id" text,
	"meta_updated_time" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adsets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"campaign_meta_id" text NOT NULL,
	"meta_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "ad_object_status" DEFAULT 'PAUSED' NOT NULL,
	"effective_status" text,
	"daily_budget" integer,
	"lifetime_budget" integer,
	"optimization_goal" text,
	"billing_event" text,
	"bid_amount" integer,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"meta_updated_time" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_account_sync_state" ADD CONSTRAINT "ad_account_sync_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_account_sync_state" ADD CONSTRAINT "ad_account_sync_state_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads" ADD CONSTRAINT "ads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads" ADD CONSTRAINT "ads_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adsets" ADD CONSTRAINT "adsets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adsets" ADD CONSTRAINT "adsets_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_sync_state_scope_idx" ON "ad_account_sync_state" USING btree ("ad_account_id","object_type","parent_meta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_sync_state_company_idx" ON "ad_account_sync_state" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_company_meta_idx" ON "campaigns" USING btree ("company_id","meta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_company_account_idx" ON "campaigns" USING btree ("company_id","ad_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_account_status_idx" ON "campaigns" USING btree ("ad_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ads_company_meta_idx" ON "ads" USING btree ("company_id","meta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_account_adset_idx" ON "ads" USING btree ("ad_account_id","adset_meta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_account_status_idx" ON "ads" USING btree ("ad_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adsets_company_meta_idx" ON "adsets" USING btree ("company_id","meta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adsets_account_campaign_idx" ON "adsets" USING btree ("ad_account_id","campaign_meta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adsets_account_status_idx" ON "adsets" USING btree ("ad_account_id","status");