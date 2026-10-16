-- Backlog #82: CEO batches that failed before #79 kept no outcome. They counted against the hourly wake limit (12
-- stopped batches blocked the CEO for an hour in production) and made the failure notice read "unknown".
UPDATE ceo_batches
   SET outcome = 'released', error = 'ended by an earlier server version (the reason was not recorded)'
 WHERE status = 'failed' AND outcome IS NULL;
