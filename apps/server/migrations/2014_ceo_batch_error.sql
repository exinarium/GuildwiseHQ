-- Why a CEO shift ended without its report (backlog #79): the runner's rejection (reason and detail), the reaper's
-- "not accepted in 30 s", a lost connection. Read by the dispatcher (backoff, one desk notice) and the CEO Overview.
ALTER TABLE ceo_batches
  ADD COLUMN outcome text,
  ADD COLUMN error   text;
