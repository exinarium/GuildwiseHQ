-- Model prices were updated (packages/shared/src/costs, September 2026 list prices): Fable 10/50, Opus 5/25,
-- Sonnet 2/10, Haiku 1/5 USD per million tokens, cache read x0.1, cache write x1.25; any other model priced as Sonnet.
-- Rows whose ShiftEnded carried its own `costMicros` keep that price; every other row is repriced from the table.
-- Safe to run again: the recompute is a pure function of the stored tokens and model.
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS cost_stamped boolean NOT NULL DEFAULT false;

UPDATE shift_costs
   SET cost_usd_micros = round(
         tokens_input       * (CASE WHEN lower(model) LIKE '%fable%' THEN 10 WHEN lower(model) LIKE '%opus%' THEN 5    WHEN lower(model) LIKE '%sonnet%' THEN 2    WHEN lower(model) LIKE '%haiku%' THEN 1    ELSE 2    END)
       + tokens_output      * (CASE WHEN lower(model) LIKE '%fable%' THEN 50 WHEN lower(model) LIKE '%opus%' THEN 25   WHEN lower(model) LIKE '%sonnet%' THEN 10   WHEN lower(model) LIKE '%haiku%' THEN 5    ELSE 10   END)
       + tokens_cache_read  * (CASE WHEN lower(model) LIKE '%fable%' THEN 1  WHEN lower(model) LIKE '%opus%' THEN 0.5  WHEN lower(model) LIKE '%sonnet%' THEN 0.2  WHEN lower(model) LIKE '%haiku%' THEN 0.1  ELSE 0.2  END)
       + tokens_cache_write * (CASE WHEN lower(model) LIKE '%fable%' THEN 12.5 WHEN lower(model) LIKE '%opus%' THEN 6.25 WHEN lower(model) LIKE '%sonnet%' THEN 2.5 WHEN lower(model) LIKE '%haiku%' THEN 1.25 ELSE 2.5 END)
       )::bigint
 WHERE NOT cost_stamped;
