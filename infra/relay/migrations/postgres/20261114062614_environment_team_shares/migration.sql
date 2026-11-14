CREATE TABLE "relay_environment_team_shares" (
	"environment_id" varchar(191),
	"organization_id" varchar(191),
	"owner_user_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"revoked_at" varchar(64),
	CONSTRAINT "relay_environment_team_shares_pkey" PRIMARY KEY("environment_id","organization_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_environment_team_shares_organization" ON "relay_environment_team_shares" ("organization_id","revoked_at");