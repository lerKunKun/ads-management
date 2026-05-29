CREATE TABLE "release_announcements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "version" text NOT NULL,
  "content" text NOT NULL,
  "next_update_at" timestamp with time zone,
  "status" text DEFAULT 'draft' NOT NULL,
  "published_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_announcement_reads" (
  "announcement_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "read_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "release_announcement_reads_announcement_id_user_id_pk" PRIMARY KEY("announcement_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "release_announcements" ADD CONSTRAINT "release_announcements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_announcement_reads" ADD CONSTRAINT "release_announcement_reads_announcement_id_release_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "release_announcements"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_announcement_reads" ADD CONSTRAINT "release_announcement_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "release_announcements_status_published_idx" ON "release_announcements" USING btree ("status","published_at");
--> statement-breakpoint
CREATE INDEX "release_announcements_created_idx" ON "release_announcements" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "release_announcement_reads_user_idx" ON "release_announcement_reads" USING btree ("user_id","read_at");
