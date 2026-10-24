-- Revision R2: where a project-repository capability lives (for the review list) and the owner's review decisions.
ALTER TABLE project_capability_index ADD COLUMN IF NOT EXISTS path text;

-- One decision per project, kind and key: reviewed at a content hash, or blocked. Projection of `ProjectCapabilityReviewed`.
CREATE TABLE IF NOT EXISTS capability_reviews (
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('skill','persona','playbook')),
  key         text NOT NULL,
  hash        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('reviewed','blocked')),
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, kind, key)
);
CREATE INDEX IF NOT EXISTS capability_reviews_org ON capability_reviews (org_id, status);
