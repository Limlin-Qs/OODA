CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  asset_number TEXT NOT NULL UNIQUE,
  serial_number TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('available', 'maintenance', 'lost', 'archived')),
  maintenance_notes TEXT NOT NULL DEFAULT '',
  attachment_notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX devices_serial_number_unique_idx
  ON devices(serial_number)
  WHERE serial_number IS NOT NULL;

CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  subject_member_id TEXT REFERENCES members(id),
  reason TEXT NOT NULL DEFAULT '',
  before_state JSONB,
  after_state JSONB,
  result TEXT NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_entries_entity_idx ON audit_entries(entity_type, entity_id, occurred_at);
CREATE INDEX audit_entries_actor_idx ON audit_entries(actor_member_id, occurred_at);
