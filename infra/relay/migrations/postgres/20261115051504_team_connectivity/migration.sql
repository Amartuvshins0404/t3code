CREATE TABLE "relay_team_connectivity" (
	"organization_id" varchar(191) PRIMARY KEY,
	"url" text NOT NULL,
	"client_key_ciphertext" text NOT NULL,
	"version" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	"updated_by_json" jsonb NOT NULL
);
