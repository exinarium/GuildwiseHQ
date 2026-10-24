-- R3c (Q63): a delegation that needed wider tools than its caller had ran narrower; the card says which profile it was cut from.
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_narrowed_from text;
