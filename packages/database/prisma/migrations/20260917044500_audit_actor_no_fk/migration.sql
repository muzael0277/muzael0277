-- Drop the AuditLog -> User foreign key.
--
-- It was declared onDelete: SetNull, which meant deleting a user issued an UPDATE against
-- AuditLog — and the append-only trigger refuses that, so a user could never be deleted
-- at all. Beyond the deadlock, nulling the actor erases who performed an action, which is
-- precisely what the audit trail exists to record. The column stays; it simply no longer
-- points at a row that may legitimately disappear.
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_actorUserId_fkey";
