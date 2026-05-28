CREATE TABLE "archived_ads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "ad_account_id" uuid NOT NULL,
  "campaign_meta_id" text,
  "adset_meta_id" text,
  "ad_meta_id" text NOT NULL,
  "ad_name" text NOT NULL,
  "status" "ad_object_status" DEFAULT 'ARCHIVED' NOT NULL,
  "effective_status" text,
  "creative_id" text,
  "post_url" text,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archived_ads" ADD CONSTRAINT "archived_ads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "archived_ads" ADD CONSTRAINT "archived_ads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "archived_ads" ADD CONSTRAINT "archived_ads_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "archived_ads_user_ad_idx" ON "archived_ads" USING btree ("company_id","user_id","ad_meta_id");
--> statement-breakpoint
CREATE INDEX "archived_ads_user_archived_idx" ON "archived_ads" USING btree ("company_id","user_id","archived_at");
--> statement-breakpoint
CREATE INDEX "archived_ads_ad_account_idx" ON "archived_ads" USING btree ("ad_account_id");
