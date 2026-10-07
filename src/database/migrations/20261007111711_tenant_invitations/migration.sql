CREATE TYPE "tenant_invitation_status" AS ENUM('PENDING', 'ACCEPTED');--> statement-breakpoint
CREATE TABLE "tenant_invitations" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" "tenant_invitation_status" DEFAULT 'PENDING'::"tenant_invitation_status" NOT NULL,
	"created_account" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_registration_requests" ADD COLUMN "reminder_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_registration_requests" ADD COLUMN "last_reminded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invitations_tenant_id_key" ON "tenant_invitations" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invitations_token_hash_key" ON "tenant_invitations" ("token_hash");--> statement-breakpoint
CREATE INDEX "tenant_invitations_user_id_idx" ON "tenant_invitations" ("user_id");--> statement-breakpoint
CREATE INDEX "tenant_invitations_status_sent_at_idx" ON "tenant_invitations" ("status","sent_at");--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;