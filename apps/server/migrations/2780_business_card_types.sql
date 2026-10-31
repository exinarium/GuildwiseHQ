-- Business mode: allow the six business card types next to the developer ones.
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_card_type_check;
ALTER TABLE cards ADD CONSTRAINT cards_card_type_check CHECK (card_type IN (
  'feature','bug','support','refactor','docs','research','feed','regression',
  'enquiry','follow_up','document_request','reminder','report','quote'
));
