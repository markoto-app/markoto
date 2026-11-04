-- allow-destructive: users.avatar_url has been unused since v0.4.1 (avatars are generated locally from the user id) and migration 0026 nulled every value, so no data is lost. Images built before this migration still select the column (Drizzle lists every schema column), so a code rollback past 0027 needs the column re-added.
-- Anonymous activity rows carry the editor's random per-tab avatar token (awareness `user.avatarSeed`) so the Activity Log shows the same face as the presence bar.
ALTER TABLE "activity_log" ADD COLUMN "actor_avatar_seed" text;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "avatar_url";
