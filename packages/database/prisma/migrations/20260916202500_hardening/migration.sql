-- Database-level guarantees that Prisma's schema language cannot express.
-- Each of these backs an invariant from docs/architecture/00-overview.md.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────────────────────────────────────────────────────────
-- I3 — no double booking.
--
-- The application already serializes writers on a ResourceDayLock row and re-checks
-- inside the transaction. This constraint is the belt to that braces: even a future
-- code path that forgets the lock cannot produce two overlapping bookings for one
-- resource. Cancelled and no-show bookings are excluded so a slot frees up correctly.
--
-- NOTE: this assumes capacity = 1, which is the MVP. Enabling capacity > 1 (group
-- classes, shared tables) requires replacing this with a counting check — see
-- docs/architecture/09-booking-engine.md before dropping it.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "Booking"
  ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "resourceId" WITH =,
    tsrange("blockStartsAt", "blockEndsAt", '[)') WITH &&
  )
  WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'));

-- A booking must occupy a positive span, and buffers must enclose the visible time.
ALTER TABLE "Booking"
  ADD CONSTRAINT "booking_time_sane"
  CHECK (
    "startsAt" < "endsAt"
    AND "blockStartsAt" <= "startsAt"
    AND "blockEndsAt" >= "endsAt"
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Money sanity. These catch a bug at the boundary instead of letting it become a
-- financial discrepancy that is discovered a month later in a report.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "Order"
  ADD CONSTRAINT "order_amounts_non_negative"
  CHECK (
    subtotal >= 0 AND "discountTotal" >= 0 AND "deliveryFee" >= 0
    AND total >= 0 AND "promoDiscount" >= 0 AND "loyaltyDiscount" >= 0
  );

ALTER TABLE "Order"
  ADD CONSTRAINT "order_total_is_consistent"
  CHECK (total = subtotal - "discountTotal" + "deliveryFee" + "taxTotal");

ALTER TABLE "Order"
  ADD CONSTRAINT "order_discount_within_subtotal"
  CHECK ("discountTotal" <= subtotal);

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "order_item_total_is_consistent"
  CHECK (total = ("unitPrice" + "modifiersPrice") * quantity - discount AND quantity > 0);

ALTER TABLE "Payment"
  ADD CONSTRAINT "payment_refund_within_amount"
  CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= amount);

-- I5 — a loyalty balance can never go negative, whatever the application does.
ALTER TABLE "LoyaltyAccount"
  ADD CONSTRAINT "loyalty_balance_non_negative" CHECK (balance >= 0);

ALTER TABLE "LoyaltyTransaction"
  ADD CONSTRAINT "loyalty_balance_after_non_negative" CHECK ("balanceAfter" >= 0);

-- Ledger direction must match the transaction type, so a sign error cannot silently
-- invert an accrual into a deduction.
ALTER TABLE "LoyaltyTransaction"
  ADD CONSTRAINT "loyalty_amount_sign_matches_type"
  CHECK (
    (type IN ('EARN', 'REFUND') AND amount > 0)
    OR (type IN ('SPEND', 'EXPIRE') AND amount < 0)
    OR (type = 'ADJUSTMENT' AND amount <> 0)
  );

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "inventory_amount_sign_matches_type"
  CHECK (
    (type IN ('PURCHASE', 'RETURN') AND quantity > 0)
    OR (type IN ('SALE', 'WRITE_OFF') AND quantity < 0)
    OR (type IN ('ADJUSTMENT', 'TRANSFER') AND quantity <> 0)
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Append-only audit log. A compromised application account must not be able to erase
-- its own tracks, so immutability is enforced by the database rather than by policy.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- Search. Trigram indexes carry global search until the tenant count makes a
-- dedicated search service worthwhile (docs/architecture/13-technical-risks.md).
-- ───────────────────────────────────────────────────────────────────────────
CREATE INDEX "customer_name_trgm" ON "Customer"
  USING gin (("firstName" || ' ' || COALESCE("lastName", '')) gin_trgm_ops);

CREATE INDEX "customer_phone_trgm" ON "Customer" USING gin (phone gin_trgm_ops);

CREATE INDEX "product_name_trgm" ON "Product"
  USING gin ((name::text) gin_trgm_ops);

CREATE INDEX "service_name_trgm" ON "Service"
  USING gin ((name::text) gin_trgm_ops);

-- Partial indexes for the lists staff actually open: active rows, recent first.
CREATE INDEX "order_open_by_tenant" ON "Order" ("tenantId", "createdAt" DESC)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED');

CREATE INDEX "booking_upcoming_by_tenant" ON "Booking" ("tenantId", "startsAt")
  WHERE status IN ('PENDING', 'CONFIRMED');

CREATE INDEX "product_low_stock" ON "Product" ("tenantId", "stockQuantity")
  WHERE "trackInventory" = true AND "lowStockThreshold" IS NOT NULL;

-- Outbox drain: the dispatcher's hot query is "pending and due, oldest first".
CREATE INDEX "domain_event_drain" ON "DomainEvent" ("availableAt")
  WHERE status IN ('PENDING', 'FAILED');
