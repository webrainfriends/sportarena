# Academy Process card and PDF guide

A new academy owner sees a **Process card** on the Organisation Command centre and the Academy Home. It walks the steps from an empty
account to the first reports (create the academy, venues, staff, suppliers, programmes, hiring coaches, inviting students, tracking
classes, taxation, revenue sharing, reports, connecting schools and studies, campuses, and running pickup and daily safety), each with the instructions, a screenshot of the real screen (phone or desktop), an
**Open this screen** button, and a **Download PDF** of the whole guide with screenshots. It complements Guided setup (`setup.js`), which
ticks steps from your records: the Process card is the "how", Guided setup is the "what is left".

## Where things live
| What | Where |
|---|---|
| Steps, targets, covered API modules, screen sources | `apps/api/src/guides/academy-process.js` |
| Capabilities (REST + OpenAPI + MCP) | `apps/api/src/capabilities/process-guides.js`: `get_process_guide`, `get_process_guide_screenshot`, `get_process_guide_pdf` |
| PDF renderer (pdfkit, English) | `apps/api/src/guides/render.js` |
| Screenshots + freshness manifest | `apps/api/assets/guides/academy/` |
| Card UI | `apps/app/src/screens/process-card.js` (used by `academy-home.js` and `org.js` Overview) |
| Titles / "why" / UI text, 11 packs + English | `guide.*` keys in `apps/app/src/i18n/*.js` (step instruction lines come from the API in English) |
| Screenshot job | `npm run guide:shots` (`scripts/e2e/academy-process-guide-journey.mjs`) |
| Guard | `apps/api/test/process-guide.test.js` |

## When you change an organisation, academy, venue, coach, tax or reporting module
1. Update the step in `academy-process.js` (text, `modules`, `sources`, `target`). A new `academy-*.js`, `org-*.js`, `organisations.js`,
   `venue-coaches.js`, `gst.js`, `provider-tax.js` or `coach-classes.js` capability file must appear in a step's `modules`
   (or in `NOT_IN_GUIDE` with a reason), otherwise the test fails.
2. Change the English title / why in `en.js` **and** every language pack (`scripts/i18n-add.mjs` for new keys; keep `en.js` equal to the API text, the test checks it).
3. Retake the screenshots: build the web app (`EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist`), then
   `E2E_DATABASE_URL=… npm run guide:shots` (throwaway Postgres; data is created through the API). Add `UX_SHOTS=docs/ux` to also photograph the card.
4. Commit the PNGs and `manifest.json`. The manifest records a hash of each step's `sources`; the test fails when a screen changed after the screenshots were taken.

## Limits
- The PDF is English only: the built-in PDF fonts cannot show Indic or Urdu text and the guide never garbles it. Other languages need a Unicode font (`DOC_FONT_REGULAR`, see `docs/localisation.md`) and per-script shaping work that is not done here. The app shows a note after a non-English download.
- The academy persona is covered; the step model allows club or venue guides later.
