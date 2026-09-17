CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  reserver_member_id TEXT NOT NULL REFERENCES members(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_at < end_at),
  CHECK ((status = 'active' AND cancelled_at IS NULL) OR
         (status = 'cancelled' AND cancelled_at IS NOT NULL) OR
         (status = 'completed'))
);

ALTER TABLE reservations
  ADD CONSTRAINT reservations_active_no_overlap
  EXCLUDE USING gist (
    device_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'active');

CREATE INDEX reservations_member_idx ON reservations(reserver_member_id, start_at);
CREATE INDEX reservations_device_idx ON reservations(device_id, start_at);
