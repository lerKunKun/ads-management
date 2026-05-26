CREATE INDEX IF NOT EXISTS "ad_accounts_company_created_idx" ON "ad_accounts" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_accounts_company_status_created_idx" ON "ad_accounts" USING btree ("company_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_accounts_company_fb_created_idx" ON "ad_accounts" USING btree ("company_id","fb_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_account_created_idx" ON "campaigns" USING btree ("ad_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adsets_account_campaign_created_idx" ON "adsets" USING btree ("ad_account_id","campaign_meta_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_account_adset_created_idx" ON "ads" USING btree ("ad_account_id","adset_meta_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_items_task_status_type_created_idx" ON "operation_task_items" USING btree ("task_id","status","target_type","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_copy_steps_task_status_type_updated_idx" ON "operation_copy_steps" USING btree ("task_id","status","source_type","updated_at","id");
