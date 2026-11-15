-- Reviewer token facts per workstation repository: whether the workstation holds a comment-only token for the repository
-- (null: the runner did not say) and why it cannot be used. Booleans and a short enum only: the token itself never
-- leaves the workstation and no column, event or log field can hold one.
ALTER TABLE workstation_repos ADD COLUMN IF NOT EXISTS reviewer_token boolean;
ALTER TABLE workstation_repos ADD COLUMN IF NOT EXISTS reviewer_token_problem text;
