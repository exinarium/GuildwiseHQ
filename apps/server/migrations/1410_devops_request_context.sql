-- "Ask DevOps" from anywhere: where a request was started and what the user was looking at (page, project, card,
-- desk item, repository, last error). Additive; older requests have neither.
ALTER TABLE devops_requests
  ADD COLUMN origin  text,
  ADD COLUMN context jsonb;
