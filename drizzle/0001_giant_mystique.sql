CREATE TABLE IF NOT EXISTS "desk_instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"template_id" integer NOT NULL,
	"current_vm_id" integer,
	"quota_id" integer,
	"spec_vcpu" integer,
	"spec_memory_mb" integer,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"provision_started_at" timestamp,
	"provision_finished_at" timestamp,
	"last_connected_at" timestamp,
	"last_disconnected_at" timestamp,
	"connect_count" integer DEFAULT 0 NOT NULL,
	"rebuild_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "desktop_ip_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"subnet" varchar(64) NOT NULL,
	"ip_address" varchar(64) NOT NULL,
	"vlan_id" integer,
	"vm_id" integer,
	"state" varchar(16) DEFAULT 'free' NOT NULL,
	"allocated_at" timestamp,
	"released_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "desktop_quotas" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"default_vcpu" integer,
	"default_memory_mb" integer,
	"max_vcpu" integer DEFAULT 8 NOT NULL,
	"max_memory_mb" integer DEFAULT 16384 NOT NULL,
	"max_disk_gb" integer DEFAULT 200 NOT NULL,
	"max_instances" integer DEFAULT 1 NOT NULL,
	"max_daily_hours" numeric(6, 2),
	"max_idle_days" integer DEFAULT 7 NOT NULL,
	"rebuild_after_days" integer DEFAULT 180 NOT NULL,
	"destroy_after_idle_days" integer DEFAULT 30 NOT NULL,
	"allow_rebuild" boolean DEFAULT true NOT NULL,
	"template_id" integer,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "desktop_quotas_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "desktop_tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_key" varchar(128) NOT NULL,
	"type" varchar(32) NOT NULL,
	"instance_id" integer,
	"vm_id" integer,
	"user_id" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"stage" varchar(32),
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"not_before" timestamp NOT NULL,
	"provider_task" varchar(128),
	"request_json" jsonb,
	"error_code" varchar(64),
	"error_message" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "desktop_tasks_task_key_unique" UNIQUE("task_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "desktop_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"os_type" varchar(32) DEFAULT 'windows' NOT NULL,
	"os_version" varchar(64),
	"provider" varchar(32) NOT NULL,
	"provider_ref" varchar(128) NOT NULL,
	"provider_node" varchar(64),
	"vcpu" integer NOT NULL,
	"memory_mb" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"storage" varchar(64),
	"network_bridge" varchar(32),
	"vlan_id" integer,
	"guest_username" varchar(64),
	"software_registry_ver" varchar(64),
	"login_script_ver" varchar(64),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"max_instances" integer,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "desktop_templates_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "desktop_vms" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer,
	"template_id" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_ref" varchar(128) NOT NULL,
	"provider_node" varchar(64),
	"name" varchar(128) NOT NULL,
	"primary_ip" varchar(64),
	"mac_address" varchar(32),
	"rdp_port" integer DEFAULT 3389 NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"protocol" varchar(16) DEFAULT 'rdp' NOT NULL,
	"power_state" varchar(16) DEFAULT 'unknown' NOT NULL,
	"vcpu" integer,
	"memory_mb" integer,
	"disk_gb" integer,
	"agent_ready" boolean DEFAULT false NOT NULL,
	"last_probe_at" timestamp,
	"probe_fail_count" integer DEFAULT 0 NOT NULL,
	"snapshot_ref" varchar(128),
	"created_at" timestamp NOT NULL,
	"started_at" timestamp,
	"stopped_at" timestamp,
	"destroyed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guac_connection_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"guac_connection_id" integer NOT NULL,
	"guac_entity_id" integer NOT NULL,
	"connection_name" varchar(192) NOT NULL,
	"target_host" varchar(128) NOT NULL,
	"target_port" integer DEFAULT 3389 NOT NULL,
	"params_hash" varchar(64),
	"read_granted" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp,
	"synced_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "desktop_mode" varchar(16) DEFAULT 'rds' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "desktop_quota_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "desktop_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desk_instances" ADD CONSTRAINT "desk_instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desk_instances" ADD CONSTRAINT "desk_instances_template_id_desktop_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."desktop_templates"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desk_instances" ADD CONSTRAINT "desk_instances_current_vm_id_desktop_vms_id_fk" FOREIGN KEY ("current_vm_id") REFERENCES "public"."desktop_vms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desk_instances" ADD CONSTRAINT "desk_instances_quota_id_desktop_quotas_id_fk" FOREIGN KEY ("quota_id") REFERENCES "public"."desktop_quotas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desktop_ip_allocations" ADD CONSTRAINT "desktop_ip_allocations_vm_id_desktop_vms_id_fk" FOREIGN KEY ("vm_id") REFERENCES "public"."desktop_vms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desktop_quotas" ADD CONSTRAINT "desktop_quotas_template_id_desktop_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."desktop_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desktop_tasks" ADD CONSTRAINT "desktop_tasks_instance_id_desk_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."desk_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desktop_tasks" ADD CONSTRAINT "desktop_tasks_vm_id_desktop_vms_id_fk" FOREIGN KEY ("vm_id") REFERENCES "public"."desktop_vms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desktop_tasks" ADD CONSTRAINT "desktop_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desktop_vms" ADD CONSTRAINT "desktop_vms_instance_id_desk_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."desk_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "desktop_vms" ADD CONSTRAINT "desktop_vms_template_id_desktop_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."desktop_templates"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "guac_connection_map" ADD CONSTRAINT "guac_connection_map_instance_id_desk_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."desk_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "guac_connection_map" ADD CONSTRAINT "guac_connection_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_desk_instances_active_user" ON "desk_instances" USING btree ("user_id") WHERE "desk_instances"."status" in ('new','provisioning','configuring','booting','probing','ready','connected','idle','suspended','failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desk_instances_status" ON "desk_instances" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desk_instances_idle" ON "desk_instances" USING btree ("last_disconnected_at") WHERE "desk_instances"."status" in ('idle','suspended');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desk_instances_updated_at" ON "desk_instances" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_desktop_ip" ON "desktop_ip_allocations" USING btree ("subnet","ip_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desktop_ip_state" ON "desktop_ip_allocations" USING btree ("subnet","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desktop_tasks_queue" ON "desktop_tasks" USING btree ("status","not_before") WHERE "desktop_tasks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desktop_tasks_instance" ON "desktop_tasks" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desktop_templates_status" ON "desktop_templates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_desktop_templates_default" ON "desktop_templates" USING btree ("is_default") WHERE "desktop_templates"."is_default" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desktop_vms_instance" ON "desktop_vms" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_desktop_vms_ref" ON "desktop_vms" USING btree ("provider","provider_ref") WHERE "desktop_vms"."destroyed_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desktop_vms_ip" ON "desktop_vms" USING btree ("primary_ip") WHERE "desktop_vms"."destroyed_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_desktop_vms_power_state" ON "desktop_vms" USING btree ("power_state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_guac_map_instance" ON "guac_connection_map" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_guac_map_conn" ON "guac_connection_map" USING btree ("guac_connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_guac_map_user" ON "guac_connection_map" USING btree ("user_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_desktop_quota_id_desktop_quotas_id_fk" FOREIGN KEY ("desktop_quota_id") REFERENCES "public"."desktop_quotas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
