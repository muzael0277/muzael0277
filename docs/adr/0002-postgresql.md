# ADR-0002 — PostgreSQL as the primary datastore

**Status:** Accepted · 2026-09-16

## Decision

PostgreSQL 16 for all operational data. Redis for cache, locks, queues and rate limits.
S3-compatible object storage for files.

## Rationale

- Orders, payments, inventory and loyalty need real transactions across multiple tables.
  This is the textbook case against a document store.
- `JSONB` gives us document flexibility exactly where we want it (custom fields, snapshots,
  rule DSLs, module config) _inside_ a relational model — not instead of one.
- `tstzrange` + GiST is purpose-built for booking overlap checks.
- `pg_trgm` covers search until it does not, deferring Meilisearch.
- Partial and composite indexes keep tenant-leading queries fast.
- Operationally boring: every host supports it, every engineer knows it.

## Consequences

One database is a single point of failure — mitigated with backups + PITR, and read
replicas as the first scaling lever. Analytics must not run ad-hoc scans on the OLTP
tables; rollups exist from day one.
