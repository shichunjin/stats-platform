CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" varchar(64) NOT NULL,
	"detail" text,
	"ip_addr" varchar(64),
	"status" varchar(16) DEFAULT 'success' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_applies" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"data_name" varchar(128) DEFAULT 'testData' NOT NULL,
	"purpose" text NOT NULL,
	"fields" jsonb,
	"filters" jsonb,
	"time_start" timestamp,
	"time_end" timestamp,
	"priority" varchar(16) DEFAULT 'medium' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"processed_by" integer,
	"finished_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "export_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"pending_file_id" integer,
	"result_name" varchar(256) NOT NULL,
	"file_path" varchar(512) NOT NULL,
	"file_size" bigint,
	"download_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guac_auth_tokens" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"auth_token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(256) NOT NULL,
	"content" text,
	"msg_type" varchar(16) DEFAULT 'info' NOT NULL,
	"link" varchar(256),
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" integer,
	"file_name" varchar(256) NOT NULL,
	"file_path" varchar(512) NOT NULL,
	"file_size" bigint,
	"file_type" varchar(16),
	"content_sha" varchar(64),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"review_reason" text,
	"reviewed_at" timestamp,
	"reviewed_by" integer,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_config" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text,
	"updated_by" integer,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"win_session_id" varchar(128),
	"guac_identifier" varchar(128),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"launched_at" timestamp NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(64) NOT NULL,
	"ad_sid" varchar(128),
	"display_name" varchar(128),
	"role" varchar(16) DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_hash" varchar(256),
	"password_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_applies" ADD CONSTRAINT "data_applies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_applies" ADD CONSTRAINT "data_applies_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "export_results" ADD CONSTRAINT "export_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "export_results" ADD CONSTRAINT "export_results_pending_file_id_pending_files_id_fk" FOREIGN KEY ("pending_file_id") REFERENCES "public"."pending_files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "guac_auth_tokens" ADD CONSTRAINT "guac_auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_files" ADD CONSTRAINT "pending_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_files" ADD CONSTRAINT "pending_files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_files" ADD CONSTRAINT "pending_files_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_config" ADD CONSTRAINT "platform_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_logs_user_id" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_data_applies_user_id" ON "data_applies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_data_applies_status" ON "data_applies" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_export_results_user_id" ON "export_results" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_export_results_expires_at" ON "export_results" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_messages_user_id_read" ON "messages" USING btree ("user_id","is_read");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pending_files_user_id" ON "pending_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pending_files_status" ON "pending_files" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ix_pending_files_active" ON "pending_files" USING btree ("user_id","file_name","content_sha") WHERE "pending_files"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_sessions_status" ON "sessions" USING btree ("status");