DROP INDEX IF EXISTS "uq_desk_instances_active_user";--> statement-breakpoint
ALTER TABLE "desk_instances" ADD COLUMN "account_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "desk_instances" ADD COLUMN "password_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_desk_instances_active_user" ON "desk_instances" USING btree ("user_id") WHERE "desk_instances"."status" in ('new','provisioning','configuring','booting','probing','ready','awaiting_account','connected','idle','suspended','failed');