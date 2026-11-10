ALTER TABLE entrants ADD COLUMN group_code text
  CHECK (group_code = 'lecturer' OR group_code ~ '^([1-9]|1[0-4])$');
