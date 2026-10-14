-- Where a repository's local working branch stands against origin on one workstation (backlog #57). Written by the
-- runner's periodic check and by "Sync now" (`repo.sync_status`, the `repo.sync` command result). Operational data,
-- not a projection: a rebuild of the projections leaves it alone and the next check refreshes it. (The clone rows of
-- `repo_clones` only exist for clones set up by the DevOps engineer, and `workstation_repos` is rewritten on every hello,
-- so neither suits a value the runner reports on its own schedule.)
CREATE TABLE repo_sync_status (
  workstation_id    uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  project_repo_id   uuid NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
  working_branch    text NOT NULL,
  state             text NOT NULL,
  ahead             integer NOT NULL DEFAULT 0,
  behind            integer NOT NULL DEFAULT 0,
  dirty             boolean NOT NULL DEFAULT false,
  on_branch         boolean NOT NULL DEFAULT false,
  checked_out_branch text,
  detail            text,
  checked_at        timestamptz NOT NULL,
  PRIMARY KEY (workstation_id, project_repo_id)
);

-- A stop that keeps the card with its agent (backlog #53): the shift row remembers it until the shift has ended.
ALTER TABLE shifts ADD COLUMN stop_keep_card boolean NOT NULL DEFAULT false;
