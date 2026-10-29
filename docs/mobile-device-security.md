# Device lock, deep links and the retry outbox (issue #599)

Ported from the closed mobile-workspace PR onto the role-based command centres of #562 (the workspace itself is not duplicated).

* **Device lock** (native only): Face ID / fingerprint / device passcode after 30 s in the background and on a cold start. Turning it on needs
  one successful check; the lock screen always offers **Sign out instead**. Kept in the platform keychain, per device. Not offered on the web.
  Settings row: Account security.
* **Deep links**: `sportarena://<kind>/<id>` and `sportarena://open?target=<kind:id>` open the same screens as a tapped push (`push.js parseTarget`).
  https links open the app only for hosts listed in `EXPO_PUBLIC_APP_HOSTS`; anything else is ignored.
* **Retry outbox** (`outbox.js`): `send(path, body, method)` now supports `patch` besides `post`. Writes need a `client_key`; the queue is in memory only.

Not run on a physical device: the biometric prompt, deep links, push taps.
