# Booking Engine

## 1. Resources, not employees

A barber, a dental chair, a car lift, a tennis court and a meeting room are the same
thing to an availability algorithm: **something bookable with a schedule**.

```ts
BookingResource { kind: EMPLOYEE | ROOM | EQUIPMENT | TABLE | VEHICLE | GENERIC
                  employeeId?  branchId  capacity  bufferBeforeMin  bufferAfterMin }
```

`capacity > 1` supports group classes and shared tables. Modelling this now — rather than
`Booking.employeeId` — is what lets the same engine serve a salon and a clinic without
a rewrite.

## 2. Availability

`getAvailability(serviceId, branchId?, resourceId?, date)` intersects, in order:

1. **Tenant working hours** (`TenantSettings.workingHours`, per weekday, in
   `Asia/Tashkent` or the tenant's timezone)
2. **Branch hours** — a branch may open later than the business
3. **Resource schedule** (`ResourceSchedule`, per weekday, multiple ranges for split shifts)
4. **Time off** (`ResourceTimeOff` — holidays, sick days, one-off blocks)
5. minus **existing bookings** for that resource, each expanded by
   `bufferBefore + duration + bufferAfter`
6. sliced into candidate starts on `slotStepMinutes` (default 15)
7. keeping only slots where `start + service.duration + buffers` still fits
8. dropping slots earlier than `now + minLeadTimeMinutes`, and later than
   `now + maxAdvanceDays`

All arithmetic happens in UTC; only presentation converts to the tenant timezone. DST is
not a live concern for Uzbekistan (UTC+5, no DST) but the code must not assume that —
timezone conversion uses a real tz library, never a fixed offset.

## 3. No double booking (invariant I3)

Availability is advisory — it can go stale between render and submit. **The server
re-checks inside the write transaction:**

```sql
BEGIN;
-- serialize all writers for this resource+day on one row
INSERT INTO "ResourceDayLock"("tenantId","resourceId","day") VALUES (...)
  ON CONFLICT DO NOTHING;
SELECT 1 FROM "ResourceDayLock"
  WHERE "tenantId"=$1 AND "resourceId"=$2 AND "day"=$3 FOR UPDATE;

-- conflict check under the lock
SELECT 1 FROM "Booking"
 WHERE "resourceId"=$2 AND status NOT IN ('CANCELLED','NO_SHOW')
   AND tstzrange("blockStartsAt","blockEndsAt") && tstzrange($4,$5)
 LIMIT 1;                       -- any row ⇒ abort with BOOKING_SLOT_TAKEN

INSERT INTO "Booking" ...;
COMMIT;
```

`blockStartsAt/blockEndsAt` are stored **including buffers**, so the overlap test is one
range comparison rather than arithmetic at query time.

Why a lock row rather than `SERIALIZABLE`: it takes a narrow, predictable lock
(one resource, one day) instead of forcing application-wide retry logic on serialization
failures, and it keeps two barbers independent. A `CHECK` + GiST exclusion constraint on
`tstzrange` is the belt to this braces and is added in the same migration where capacity

> 1 is enabled (capacity makes a plain exclusion constraint insufficient).

The I3 tests in `invariants.spec.ts` fire N concurrent requests at one slot and assert exactly
one `201` and N−1 `409 BOOKING_SLOT_TAKEN`.

## 4. Lifecycle

```
PENDING ─▶ CONFIRMED ─▶ ARRIVED ─▶ IN_PROGRESS ─▶ COMPLETED
    └──────────┴─────────┴─▶ CANCELLED / NO_SHOW
```

`PENDING` exists for tenants requiring manual confirmation or prepayment
(`bookingSettings.autoConfirm`, `requirePrepayment`). Every transition writes
`BookingStatusHistory` and emits an event.

## 5. Reminders

On `booking.created`, delayed BullMQ jobs are scheduled at the tenant's configured offsets
(default 24 h and 2 h before). Each job re-reads the booking and no-ops if it was
cancelled or rescheduled; `Notification` rows are unique on
`(bookingId, templateKey, scheduledFor)` so a duplicate reminder cannot be sent even if a
job runs twice. Rescheduling cancels the old jobs and schedules new ones.
