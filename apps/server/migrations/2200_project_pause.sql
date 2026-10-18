-- Manual project pause (an organization Owner or Admin benches a whole project): the state is projected from
-- ProjectPaused / ProjectResumed, so a projection rebuild (which truncates `projects` and replays ProjectCreated) restores
-- it from the events. All three are NULL while the project runs.
ALTER TABLE projects
  ADD COLUMN paused_at    timestamptz,
  ADD COLUMN paused_by    uuid,
  ADD COLUMN pause_reason text;
