-- Provider profile pictures (GitHub / Google / OIDC) are no longer stored:
-- avatars are generated locally from the user id. Forget the stored URLs.
-- The column stays (nothing reads or writes it) so a code rollback keeps working.
UPDATE "users" SET "avatar_url" = NULL WHERE "avatar_url" IS NOT NULL;
