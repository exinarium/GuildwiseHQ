-- "Check for updates" on the Workstations page: the latest request and the runner's answer per workstation
-- (operational, written by the routes and the runner gateway, never by events):
-- { "requestedAt": iso, "result": { "outcome", "version", "detail", "at" } | absent }.
ALTER TABLE workstations ADD COLUMN runner_update_check jsonb;
