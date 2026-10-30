-- The language a person reads the app in (a language-pack code: en, hi, mr, ta, te, ml, kn, bn, or, si, ur, id). NULL = follow the device.
-- Additive only; people who already chose a WhatsApp/SMS language keep it as their starting interface language.
ALTER TABLE users ADD COLUMN IF NOT EXISTS language text;
UPDATE users u SET language = split_part(p.comm_locale, '-', 1)
  FROM notification_prefs p
 WHERE p.user_id = u.id AND u.language IS NULL
   AND split_part(p.comm_locale, '-', 1) IN ('en','hi','mr','ta','te','ml','kn','bn','or','si','ur','id')
   AND p.comm_locale <> 'en-IN';
