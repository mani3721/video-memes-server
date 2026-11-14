-- Normalise Postgres-style timestamps ("2026-08-30 17:44:58.529179+00") from
-- the CSV import to ISO-8601 UTC ("2026-08-30T17:44:58.529179Z") so they sort
-- and compare correctly against timestamps the API writes. Safe to re-run.
UPDATE "memes" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "memes" SET "updated_at" = replace(substr("updated_at", 1, length("updated_at") - 3), ' ', 'T') || 'Z' WHERE "updated_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "memes" SET "flagged_at" = replace(substr("flagged_at", 1, length("flagged_at") - 3), ' ', 'T') || 'Z' WHERE "flagged_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "profiles" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "favorites" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "collections" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "collections" SET "updated_at" = replace(substr("updated_at", 1, length("updated_at") - 3), ' ', 'T') || 'Z' WHERE "updated_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "collection_items" SET "added_at" = replace(substr("added_at", 1, length("added_at") - 3), ' ', 'T') || 'Z' WHERE "added_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "reaction_events" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "download_events" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "notifications" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "notification_reads" SET "read_at" = replace(substr("read_at", 1, length("read_at") - 3), ' ', 'T') || 'Z' WHERE "read_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "blog_posts" SET "published_at" = replace(substr("published_at", 1, length("published_at") - 3), ' ', 'T') || 'Z' WHERE "published_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "blog_posts" SET "created_at" = replace(substr("created_at", 1, length("created_at") - 3), ' ', 'T') || 'Z' WHERE "created_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "blog_posts" SET "updated_at" = replace(substr("updated_at", 1, length("updated_at") - 3), ' ', 'T') || 'Z' WHERE "updated_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "feature_flags" SET "updated_at" = replace(substr("updated_at", 1, length("updated_at") - 3), ' ', 'T') || 'Z' WHERE "updated_at" LIKE '____-__-__ __:__:__%+00';
UPDATE "user_consent" SET "updated_at" = replace(substr("updated_at", 1, length("updated_at") - 3), ' ', 'T') || 'Z' WHERE "updated_at" LIKE '____-__-__ __:__:__%+00';
