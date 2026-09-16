# ADR-0001 — Modular monolith over microservices

**Status:** Accepted · 2026-09-16

## Context
BizBot OS spans ~20 domains. The instinct is a service per domain. We are an early-stage
startup building for Uzbek SMBs at a low price point, with a small team.

## Decision
One NestJS application (`apps/api`), organised into strictly bounded domain modules,
deployed as a single container — and booted a second time as a worker process from the
same codebase (`main.worker.ts`), sharing the DI container.

## Rationale
* Checkout touches cart, catalog, inventory, promotions, loyalty, orders and payments.
  As services that is a distributed transaction; as a monolith it is one
  `$transaction` — and correctness here *is* the product.
* One deploy, one log stream, one debugger. A two-person team can move.
* Cost: one VPS instead of a cluster.

## Consequences
* Boundaries must be enforced by discipline and tooling, since the compiler will not.
  ESLint import rules forbid cross-domain repository access; domains talk through
  services or events.
* Scaling is vertical plus horizontal replicas of the same image first.
* Extraction later is realistic *because* each domain already owns its data access and
  communicates through events.

## Alternatives
**Microservices** — rejected: operational cost and distributed-transaction complexity
buy nothing at our stage. **Serverless** — rejected: cold starts hurt Telegram webhooks,
and connection pooling against Postgres becomes the main engineering problem.
