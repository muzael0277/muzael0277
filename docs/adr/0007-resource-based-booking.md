# ADR-0007 — Booking is modelled on resources, not employees

**Status:** Accepted · 2026-09-16

## Context
The obvious model is `Booking.employeeId`. It works for barbershops and fails for
clinics (rooms), car services (lifts), sports (courts) and restaurants (tables).

## Decision
`BookingResource` is the bookable unit, with `kind ∈ {EMPLOYEE, ROOM, EQUIPMENT, TABLE,
VEHICLE, GENERIC}`, `capacity`, its own schedule and time off. An `Employee` is joined to
a resource when `kind = EMPLOYEE`.

## Rationale
The availability algorithm does not care what the resource *is*. Introducing the
indirection now costs one join; retrofitting it later means migrating every booking,
every schedule and every availability query in production.

## Consequences
Slightly more indirection in the salon case, which is the most common one — softened by
auto-creating a resource whenever an employee is created, so tenants never see the
concept unless they need it. `capacity > 1` (group classes, shared tables) is supported
by the data model and gated off in MVP UI.
