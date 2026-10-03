-- Runner token rotation (M2 hardening): a freshly issued token waits here until the runner connects with it, at which
-- point it replaces workstations.token_hash (WorkstationTokenRotated). Operational, not event-sourced.
CREATE TABLE runner_token_rotations (
  workstation_id uuid PRIMARY KEY REFERENCES workstations(id),
  token_hash     text NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL
);
