-- The desk-mail feature was removed (owner decision, 2026-10-10): drop its once-only marker table and its settings.
DROP TABLE IF EXISTS desk_mail_log;
DELETE FROM platform_settings WHERE key LIKE 'desk\_mail\_%';
