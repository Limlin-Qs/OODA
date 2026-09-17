CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_entries are append-only';
END;
$$;

CREATE TRIGGER audit_entries_append_only
BEFORE UPDATE OR DELETE ON audit_entries
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
