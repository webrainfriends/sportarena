# Payments (Stripe + PayPal)

Shop orders, coach sessions and insurance policies are paid through **hosted checkout**: the person is sent to
Stripe or PayPal, pays there, and comes back. Card details never reach SportArena (no PCI scope beyond redirecting).

## How it works
1. The app creates the thing (order / hire / policy). With a provider enabled it starts **unpaid**
   (`awaiting_payment` / `unpaid` / `pending_payment`) and cannot be shipped / confirmed / claimed against.
2. `create_payment` reads the **amount from the database** (never from the client), creates a Stripe Checkout Session or a
   PayPal order, and returns `checkout_url`.
3. After checkout the payment is settled by whichever arrives first, all idempotent and all verified with the provider:
   the **return page** (`?payment=<id>&result=success` → `confirm_payment`, which also captures an approved PayPal order),
   the **webhook**, or the "I've paid — check" button.
4. Settling checks amount + currency against the record; a mismatch fails the payment and fulfils nothing.
5. Cancelling a paid order / hire **refunds at the provider first**; if the provider refuses, nothing is cancelled.
   If something is cancelled while the payment is in flight, the late payment is refunded automatically.

With no keys configured nothing changes: orders/hires/policies are created as before and the app says online payment is off.

## Configure (GitHub → Settings → Secrets and variables → Actions)
| Name | Kind | Value |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | `sk_test_…` / `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | secret | `whsec_…` of the webhook endpoint below |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | secret | REST app credentials |
| `PAYPAL_WEBHOOK_ID` | secret | id of the PayPal webhook below |
| `PAYPAL_ENV` | variable | `sandbox` (default) or `live` |
| `PAYMENT_CURRENCY` | variable | ISO code, default `INR`. PayPal only accepts currencies your PayPal account supports. |

Webhook endpoints (must be **HTTPS** — enable `ENABLE_TLS`; Stripe/PayPal live mode refuse plain HTTP):
* Stripe → `https://<host>/api/v1/webhooks/stripe`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`
* PayPal → `https://<host>/api/v1/webhooks/paypal`, events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`

Stripe signatures are verified locally (HMAC, 5-minute tolerance); PayPal webhooks are verified through PayPal's
`verify-webhook-signature` API. Unverified calls get `400` and change nothing.

## Known limits
* Money lands in **your** Stripe/PayPal account. Paying sellers/coaches out (Stripe Connect / PayPal Payouts) is not built.
* Unpaid orders hold their stock until paid or cancelled by the buyer (no automatic expiry yet).
* Prices display as ₹ in the app; the charge uses `PAYMENT_CURRENCY`.
* Tested against local stand-ins of both provider APIs (`apps/api/test/payments.test.js`); run a sandbox payment end to
  end once real test keys are in place.
