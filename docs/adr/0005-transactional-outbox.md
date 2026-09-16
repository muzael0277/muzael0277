# ADR-0005 — Transactional outbox for domain events

**Status:** Accepted · 2026-09-16

## Context
Notifications, CRM timeline, loyalty accrual, analytics, webhooks and (later) automations
all react to the same business facts. Calling each one inline from `OrderService` makes
that service own everything and fail when any of it fails.

## Decision
Business change and `DomainEvent` row are written in one transaction; a dispatcher drains
the table to in-process handlers and BullMQ jobs.

## Rationale
* Publishing to a broker inside a transaction is a lie — the transaction can roll back
  after the message is out. The outbox removes that class of bug.
* A queue outage delays events; it never loses them.
* Adding an automation engine later becomes "subscribe to existing events" rather than an
  invasive refactor. This is the single highest-leverage decision for the roadmap.

## Consequences
Delivery is at-least-once, so handlers must be idempotent (`EventHandlerRun` keyed on
`(eventId, handlerName)`). Ordering is guaranteed per aggregate only. The outbox table
grows and needs partitioning/archival (watch list in `13-technical-risks.md`).
