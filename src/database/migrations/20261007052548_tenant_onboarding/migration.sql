CREATE TYPE "tenant_onboarding_mode" AS ENUM('SELF_SIGNUP', 'ADMIN_ONLY');--> statement-breakpoint
CREATE TYPE "tenant_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "email_token_type" ADD VALUE 'INVITE';--> statement-breakpoint
CREATE TABLE "tenant_registration_requests" (
	"id" text PRIMARY KEY,
	"business_name" text NOT NULL,
	"owner_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"address" text NOT NULL,
	"extra" jsonb DEFAULT '{}' NOT NULL,
	"status" "tenant_request_status" DEFAULT 'PENDING'::"tenant_request_status" NOT NULL,
	"rejection_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "tenant_onboarding_mode" "tenant_onboarding_mode" DEFAULT 'SELF_SIGNUP'::"tenant_onboarding_mode" NOT NULL;--> statement-breakpoint
CREATE INDEX "tenant_registration_requests_status_idx" ON "tenant_registration_requests" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_registration_requests_pending_email_idx" ON "tenant_registration_requests" (lower("email")) WHERE "status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "tenant_registration_requests" ADD CONSTRAINT "tenant_registration_requests_reviewed_by_users_id_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tenant_registration_requests" ADD CONSTRAINT "tenant_registration_requests_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL;