-- Card priority labels: Urgent 1, High 3, Normal 5, Low 8. The old default priority was 2, which now reads as Urgent,
-- so cards that carry it become Normal (5). The CardCreated projector applies the same rule, so a rebuild agrees.
UPDATE cards SET priority = 5 WHERE priority = 2;
