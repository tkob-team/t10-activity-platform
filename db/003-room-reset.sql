ALTER TABLE rooms ALTER COLUMN join_hash DROP NOT NULL;
ALTER TABLE rooms DROP CONSTRAINT rooms_state_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_state_check
  CHECK (state IN ('OPEN','PAUSED','CLOSED','FINALIZED','ARCHIVED'));
DROP INDEX one_live_room;
CREATE UNIQUE INDEX one_live_room ON rooms ((1)) WHERE state NOT IN ('FINALIZED','ARCHIVED');
