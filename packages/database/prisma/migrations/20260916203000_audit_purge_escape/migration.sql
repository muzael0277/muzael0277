-- The append-only audit trigger made tenant deletion impossible: deleting a Tenant
-- cascades into AuditLog, and the trigger refused the cascade. A business must be able
-- to leave the platform, and data-protection law requires an erasure path.
--
-- The fix keeps the security property intact. UPDATE stays permanently forbidden — an
-- audit row must never be edited, and there is no legitimate reason to. DELETE is
-- permitted only when a transaction explicitly opts in via a session setting, which the
-- normal application path never does. An attacker holding application credentials
-- therefore still cannot erase their tracks by issuing ordinary DELETEs; only a
-- deliberate purge routine that sets the flag can, and that routine is itself audited.

CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND COALESCE(current_setting('bizbot.allow_audit_purge', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'A retention purge or tenant deletion must SET LOCAL bizbot.allow_audit_purge = ''on'' inside its transaction.';
END;
$$ LANGUAGE plpgsql;
