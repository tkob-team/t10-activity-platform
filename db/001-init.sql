CREATE TABLE rooms (
  id uuid PRIMARY KEY, title text NOT NULL, join_hash text NOT NULL, pack_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN','PAUSED','CLOSED','FINALIZED')),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer NOT NULL DEFAULT 0, final_report jsonb
);
CREATE UNIQUE INDEX one_live_room ON rooms ((1)) WHERE state <> 'FINALIZED';

CREATE TABLE entrants (
  id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES rooms(id), name text NOT NULL,
  session_hash text NOT NULL UNIQUE, recovery_hash text NOT NULL UNIQUE,
  UNIQUE (room_id,id)
);
CREATE UNIQUE INDEX entrant_room_name ON entrants (room_id,lower(name));

CREATE TABLE submissions (
  id uuid PRIMARY KEY, room_id uuid NOT NULL, entrant_id uuid NOT NULL,
  FOREIGN KEY (room_id,entrant_id) REFERENCES entrants(room_id,id),
  idempotency_key uuid NOT NULL, fingerprint text NOT NULL, suite jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('PREVIEW','SCORE')),
  status text NOT NULL CHECK (status IN ('QUEUED','VERIFYING_ORIGINAL','EVALUATING','ORIGINAL_FAILED','PREVIEWED','GRADED','REVIEW_REQUIRED')),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  original jsonb, UNIQUE (entrant_id,idempotency_key)
);
CREATE INDEX submission_room ON submissions(room_id,accepted_at);
CREATE UNIQUE INDEX one_active_per_mode ON submissions(entrant_id,mode)
  WHERE status IN ('QUEUED','VERIFYING_ORIGINAL','EVALUATING');

CREATE TABLE tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id),
  variant text NOT NULL, status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','LEASED','PASSED','KILLED','SURVIVED','ORIGINAL_FAILED','INCONCLUSIVE','EXCLUDED')),
  attempt integer NOT NULL DEFAULT 0, fence integer NOT NULL DEFAULT 0,
  ready_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_until timestamptz,
  evidence jsonb, UNIQUE (submission_id,variant)
);
CREATE INDEX work_queue ON tasks(ready_at,id) WHERE status='QUEUED';
CREATE INDEX expired_tasks ON tasks(lease_until) WHERE status='LEASED';
CREATE TABLE attempts (
  task_id bigint NOT NULL REFERENCES tasks(id), fence integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  evidence jsonb, PRIMARY KEY(task_id,fence)
);
CREATE TABLE exclusions (
  room_id uuid NOT NULL REFERENCES rooms(id), variant text NOT NULL,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(room_id,variant)
);
CREATE TABLE awards (
  room_id uuid NOT NULL, entrant_id uuid NOT NULL, variant text NOT NULL,
  FOREIGN KEY (room_id,entrant_id) REFERENCES entrants(room_id,id),
  task_id bigint NOT NULL REFERENCES tasks(id),
  awarded_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
  PRIMARY KEY(room_id,entrant_id,variant)
);
CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id), action text NOT NULL, details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
