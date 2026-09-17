CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  borrow_id TEXT NOT NULL REFERENCES borrow_records(id),
  recipient_member_id TEXT NOT NULL REFERENCES members(id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  UNIQUE (borrow_id, stage)
);

CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result TEXT NOT NULL CHECK (result IN ('sent', 'failed')),
  error_message TEXT NOT NULL DEFAULT '',
  UNIQUE (notification_id, attempt_number)
);

CREATE INDEX notifications_recipient_idx ON notifications(recipient_member_id, created_at);
CREATE INDEX notifications_delivery_idx ON notifications(status, next_attempt_at);
