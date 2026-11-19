-- Create the litellm database on first Postgres init.
-- Mounted into postgres at /docker-entrypoint-initdb.d/01-litellm-db.sql
-- and runs once on a fresh data directory. For existing volumes, the
-- LiteLLM container runs CREATE DATABASE itself via the bootstrap
-- one-shot service (see deploy/compose/compose.base.yml: db-init).
--
-- Why a separate DB rather than a schema?  LiteLLM's Prisma migrations
-- expect a clean DB and run their own setup; sharing the schema with
-- the app's tables would risk cross-collisions on table names like
-- `users`. Two databases on one Postgres instance is the recommended
-- LiteLLM operator pattern.

SELECT 'CREATE DATABASE litellm'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')
\gexec
