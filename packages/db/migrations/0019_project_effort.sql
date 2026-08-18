-- A project's effort override.
--
-- NULL is "no preference", never "low": every station keeps its own default
-- (see STATION_EFFORT in @specd/shared) unless a project says otherwise, and a
-- project that never expressed one must not be quietly moved off those.
ALTER TABLE projects
  ADD COLUMN effort text;

ALTER TABLE projects
  ADD CONSTRAINT projects_effort_is_a_level
    CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
