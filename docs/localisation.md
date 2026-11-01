# Language packs (ta, te, ml, mr, kn, bn, or, hi, si, ur, id + English)

A standing requirement (see `CLAUDE.md`): every feature ships its text in all of these languages.

## How it works
- **Catalogue:** `apps/app/src/i18n/` — `en.js` is the source of truth, one file per language, `catalogue.js` holds the language list
  (code, default locale, native name, script, `rtl`, `reviewed`) and `translate()`. `index.js` exposes `t(key, params)`.
- **Choosing a language:** the language follows the locale chosen in the account sheet (`locale.js` → `LOCALES`, now including `or-IN` and `ur-IN`), else the device. Anything not translated falls back to English.
- **Right-to-left:** Urdu sets `dir="rtl"` on web and `I18nManager.forceRTL` on native (applied on the reload the language change already triggers).
- **API:** `users.language` (migration 132, additive, nullable = follow the device) is read by `GET /me` and set by `PATCH /me` with one of `LANGUAGE_CODES` (`comms-catalogue.js`). WhatsApp/SMS languages (`comm_locale`) now offer the same languages; a template that does not exist in the person's language falls back to `en-IN` (no template rows are seeded).
- **Review status:** every non-English pack is machine-drafted and flagged `reviewed: false`; the account sheet says so. Flip the flag only after a native speaker signs the text off.

## Adding text
1. Add the key to `en.js`, then to each of the 11 other files (same `{placeholders}`).
2. Use `t('key')` in the screen — including `accessibilityLabel`s.
3. `npm test` (`test/i18n-catalogues.test.js`) fails on a missing key, blank text or placeholder mismatch.

## Coverage today
Translated: account sheet (appearance, language, log out), common actions, generic error/empty text, bottom navigation labels.
English fallback: the rest of the screens (about 240 files) until they are moved to `t()`; error messages from the API (still English `message`; stable `code` is the hook for translation).

## Not done yet (gaps)
- Migrating the remaining screens and API error `message_key`s.
- Script-aware search normalisation (Indic/Arabic diacritic folding) for people and venue search.
- PDFs: Indic and Urdu scripts still return 422 until a Noto font is configured via `DOC_FONT_REGULAR` (see `docs/branded-documents.md`); no fonts are committed.
- Approved WhatsApp/SMS templates per language (need provider approval).
