# Local production-style services

The application is intentionally stopped while this migration is prepared. The
SQLite database remains the source of truth until a migration has been verified.

`docker compose up -d` starts only the open-source PostgreSQL and Redis services.
The API and worker must not be started until the migration and validation steps
are complete.

- PostgreSQL stores durable job state, checkpoints, and comparison snapshots.
- Redis is the queue broker for BullMQ workers.
- The existing SQLite file is never deleted or overwritten by this stack.
