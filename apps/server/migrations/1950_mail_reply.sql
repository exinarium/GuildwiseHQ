-- Replies sent from inside Guildwise (#15): who sent an outgoing message.
ALTER TABLE mail_messages ADD COLUMN sent_by uuid;
