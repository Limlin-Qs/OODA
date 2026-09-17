CREATE TABLE borrow_records (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  borrower_member_id TEXT NOT NULL REFERENCES members(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'returned')),
  borrowed_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  returned_at TIMESTAMPTZ,
  return_notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'active' AND returned_at IS NULL) OR
         (status = 'returned' AND returned_at IS NOT NULL))
);

CREATE UNIQUE INDEX borrow_records_active_device_unique_idx
  ON borrow_records(device_id)
  WHERE status = 'active';

CREATE INDEX borrow_records_borrower_idx ON borrow_records(borrower_member_id, borrowed_at);
CREATE INDEX borrow_records_device_idx ON borrow_records(device_id, borrowed_at);

CREATE TABLE idempotency_keys (
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_member_id, operation, idempotency_key)
);
