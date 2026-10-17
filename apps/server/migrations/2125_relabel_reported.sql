-- Measurement (Lean Team v3, stream S1b): a shift whose terminal report was accepted and whose claim was then released
-- ended as "stopped" in 577 cases. It did its work and reported: it is "reported". The projection of ShiftEnded applies the
-- same rule from now on (and when the projections are rebuilt); this repairs the history in place.
UPDATE shifts SET outcome = 'reported' WHERE outcome = 'stopped' AND report_outcome IS NOT NULL;
