# Live UI verification of returns, evidence, vouchers and export (#389, gap 1)

Method: the web build (`expo export --platform web`) served next to a freshly migrated API and PostgreSQL, driven with Playwright (Chromium) as real users who signed in through the app's login screen and reached the agreement from Notifications. Data was created through the API only. Each run used a new agreement.

Widths: phone 420, tablet 820, desktop 1280 (the same React Native code runs on iOS, iPadOS, Android and web; native iOS and Android binaries cannot be launched in the cloud session, so the native-only paths below were reviewed in code, not run on a device).

| Journey (all three widths) | Result |
| --- | --- |
| Recipient reports a return with a photo; sending without consent is refused with a clear message | pass |
| The attached file appears on the return and **View** opens the stored file | pass |
| Sponsor disputes the return: a case number and status appear on the return | pass |
| Sponsor exports deliveries, returns and vouchers: a CSV downloads and lists the disputed return | pass |
| Recipient sees the same case, **Open case** shows the thread, **Add evidence** is offered | pass |
| Coaching voucher offers the recipient's own coaching sessions and redeems against one | pass |

| State (all three widths) | Result |
| --- | --- |
| Loading (deal response delayed) | pass |
| Empty (no vouchers issued yet) | pass |
| Denied (a sponsor role without payment permission: no Issue button, explanation shown; the response was rewritten in the browser, the server-side refusal is covered by the API suites) | pass |
| Stale (the return was answered elsewhere, then disputed from an old screen): refused with a clear message, screen reloads | pass |
| Recoverable error (request aborted): the form keeps its input and the error shows; retry succeeds | pass |

Defects found and fixed during the run: the consent switch could be left off and only failed on the server (now checked before sending); CSV export did nothing on phones and tablets (the older dispute export too; both now share one helper that uses the share sheet).

Not run on a device: camera and photo-library permission prompts, the native document picker, and the share sheet on iOS, iPadOS and Android. These use Expo's `expo-image-picker`, `expo-document-picker`, `expo-file-system` and `expo-sharing`, which the app already uses for other uploads and downloads.
