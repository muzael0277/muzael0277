# ADR-0008 — TypeScript everywhere: Next.js + NestJS

**Status:** Accepted · 2026-09-16

## Decision

Next.js (App Router) + React + Tailwind for `web`, `admin` and `miniapp`; NestJS for the
API; TypeScript in strict mode across a pnpm + Turborepo monorepo.

## Rationale

- One language means zod schemas, permission definitions, money helpers and error codes
  are _shared artifacts_, not parallel implementations that drift.
- NestJS gives the DI, guards, interceptors and module boundaries that a modular monolith
  needs — the alternative is reinventing them in Express.
- Next.js gives SEO for the public site, server components for the dashboard shell, and a
  small, fast bundle for the Mini App (which runs on mid-range Android phones over mobile
  data — a real constraint in this market).
- Tailwind keeps three frontends visually consistent through one token set in
  `packages/ui`.

## Consequences

Node's single-threaded CPU limits mean heavy work (image processing, report generation)
belongs on the worker. The team hires for one stack. `strict: true` with
`noUncheckedIndexedAccess` is non-negotiable — `any` in a money or tenant path is how the
invariants above get broken.
