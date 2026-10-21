# Provider earnings, settlement and reconciliation

Issue [#71](https://github.com/webrainfriends/sportarena/issues/71) (PROD-08). Migration `075_provider_settlement.sql`, code in `apps/api/src/settlement.js`
and `apps/api/src/capabilities/settlement.js`, screens `Earnings` (More → Earnings) and the **Provider payouts** tab of the partner console.

## Whose money is it?

| What the customer paid for | Whose funds | Where it is tracked |
|---|---|---|
| Coach hires, physio/doctor appointments and session packages, shop orders and carts | **Provider funds** — the platform collected it and owes the seller | `provider_ledger` (this feature) |
| Venue bookings and venue plans | **Venue operator** funds, settled by contract | partner `settlements` ([partners.md](partners.md)) — not duplicated here |
| Wallet top-ups, gift cards | **Platform stored value** owed to the customer, not provider money | wallet ([wallet.md](wallet.md)) |
| Insurance premiums | Insurer premium | insurance ([insurance.md](insurance.md)) |

`payments.status = 'paid'` still means only *the customer paid the platform*. A seller has been paid only when a **payout** is recorded as `paid`.
The earnings screen shows the customer-payment status on each line and keeps "available", "on its way" and "paid to you" separate.

## The ledger

`provider_ledger` is append-only (a database trigger rejects UPDATE and DELETE; corrections are new compensating lines). One line per effect, signed
in the seller's favour, one currency per line, each with an `idempotency_key` so a retry, replayed webhook or repeated reconcile cannot post twice.

| kind | amount | when |
|---|---|---|
| `sale` | + gross | a provider payment is marked paid (same transaction as `paid`) |
| `commission` | − fee | at the same time, `PROVIDER_COMMISSION_BP` snapshot stored on the line |
| `refund` / `commission_reversal` | − refund / + fee returned in proportion | a refund (full, partial, cancelled order). A cart line comes out of that line's seller only; anything else pro rata |
| `chargeback` | − disputed share | a lost card dispute, posted by the platform team |
| `payout` / `payout_reversal` | − amount / + amount | a payout starts / fails |

`tax_cents` is the tax contained in a sale (physio/doctor services with a `taxable` class under the seller's own registered rate, same maths as the
practice report). It is informational — the seller remits it — and is not deducted. Totals per seller and currency:

```
net earned = gross − platform fee − refunds − chargebacks
payable    = net earned − paid out − payouts in progress
available  = payable that is past its hold period − open holds
```

`get_earnings` returns these, each currency on its own, plus `reconciles` (the ledger lines add up to the headline numbers).

## Payout lifecycle

1. **Seller adds a bank account** (`set_payout_account`): per currency, bank details encrypted (`payout_accounts.details`), only the last four characters shown back. Saving again supersedes the old account (kept as history) and it must be verified again.
2. **Platform team verifies** (`decide_payout_account`): checks the holder name matches; nobody can verify their own account. Reading full details (`reveal_payout_account`) is audit-logged.
3. **Start a payout** (`create_provider_payout`, or *Ready to pay → Start payout*): needs `SETTLEMENT_PAYOUTS=on`, a verified account in a supported currency and an available balance. It pays everything currently available (holds and the hold period excluded). One payout in flight per seller and currency (unique index). `idempotency_key` makes a retry return the same payout. The amount leaves the balance immediately.
4. **Send the transfer** to the bank yourself — automated rails (Stripe Connect, PayPal Payouts) are **not built**; `method` is `bank_transfer` only.
5. **Record the result** (`record_provider_payout_result`): `paid` needs the transfer reference (unique across payouts); `failed` needs a reason code and an explanation. A failed payout returns the money to the balance, opens a `payout_failed` exception and tells the seller why and what to do. Repeating the same result is a no-op; flipping a finished payout is refused.

Segregation of duties: a platform user cannot verify, pay, hold, release or resolve disputes on their **own** earnings.

## Holds, disputes, reversals

* `place_settlement_hold` / `release_settlement_hold` keep part of a balance out of payouts (optionally tied to a case that links the payment; the hold lands on the case timeline). Held money stays in the ledger.
* A verified **Stripe `charge.dispute.created`** (or PayPal `CUSTOMER.DISPUTE.CREATED`) event holds each seller's share automatically and opens a `provider_dispute` exception. PayPal does not send the amount in minor units here, so the whole un-refunded payment is held.
* `resolve_settlement_exception` closes it: **release** (dispute won, hold ends) or **reverse** (lost: `chargeback` lines take the sellers' share and fee back, holds end). There is no capability that edits a ledger line.
* Stripe **`charge.refunded`** with more refunded than we recorded opens `refund_unrecorded` (a refund made in the provider dashboard). It resolves itself when our own refund is recorded; otherwise review it.
* A provider amount that does not match the order fails the payment (as before) and now also opens `amount_mismatch`.

## Webhooks

Signatures are verified before anything else (Stripe HMAC, PayPal verify API). Each verified event id is stored in `provider_events`; a replay is acknowledged (`{"received":true,"duplicate":true}`) without being applied again. Applying is idempotent anyway, so a crash between "applied" and "recorded" only means the next delivery re-applies harmlessly.

## Reconciliation

* `get_settlement_reconciliation` (read-only): per currency, customer payments for provider sales net of refunds vs the ledger, payments still missing from the ledger, owed to sellers, fees kept, payouts in progress/paid, holds, other funds listed separately, and open exceptions by kind. `balanced` is true only when both sides agree to the cent and no payment is missing.
* `reconcile_settlement` (POST, safe to repeat, up to 500 payments per run): posts sales for provider payments that have none — **this is how payments made before this feature existed are back-filled** — brings refunds in line, and opens `ledger_drift` / `share_mismatch` exceptions for anything it cannot fix. Run it once after deploying.

## Configuration (GitHub → Settings → Variables)

| Variable | Default | Meaning |
|---|---|---|
| `PROVIDER_COMMISSION_BP` | `0` | platform fee on provider sales, basis points (1000 = 10%) |
| `SETTLEMENT_HOLD_DAYS` | `0` | days a sale stays unpayable (refund/dispute window); change affects new sales only |
| `SETTLEMENT_CURRENCIES` | `PAYMENT_CURRENCY` | currencies payouts and payout accounts are accepted in |
| `SETTLEMENT_MIN_PAYOUT_CENTS` | `1` | smallest payout |
| `SETTLEMENT_PAYOUTS` | `off` | live payouts; earnings accrue and are visible while it is off |

### Before switching payouts on
1. Run `reconcile_settlement` until `more` is false, then check `get_settlement_reconciliation` shows `balanced` for each currency and no open exceptions you do not understand.
2. Confirm sellers' accounts are verified and that you can actually send bank transfers in each supported currency.
3. Set the commission and hold days you want, then set `SETTLEMENT_PAYOUTS=on`.

## Operational failure modes

| Symptom | Meaning / action |
|---|---|
| Exception `share_mismatch` | A payment's sellers could not be determined, or their shares do not add up to the amount paid. Nothing was posted. Fix the underlying record, run reconciliation, close the exception. |
| Exception `refund_unrecorded` | The provider refunded more than the ledger knows. If it was our refund it resolves itself; otherwise find the refund in the provider dashboard. |
| Exception `ledger_drift` | Ledger and payment disagree after a repair attempt. Investigate before paying that seller. |
| Exception `payout_failed` | Bank rejected a transfer; the seller has been told. Resolve once a corrected account is verified and a new payout is made. |
| Payout stuck `processing` | Transfer sent but result not recorded. Record it; no second payout can start until you do. |
| Refund succeeded at the provider but the API returned an error | The payment row and ledger move in one transaction and the provider call is idempotent: repeat the same refund. |

## Limits

* No escrow: the platform holds customer money in its own provider account and states nothing about legal escrow. Holds are bookkeeping.
* No automated payout rails or payout webhooks (Stripe Connect / PayPal Payouts); payouts are manual bank transfers recorded by the platform team.
* Payment-gateway fees are not deducted from sellers (only the platform fee). Tax is reported, not computed for shop/coach sales (no tax profile exists for them).
* The commission is one platform-wide rate, not per category or per seller.
* Venue money stays on partner contracts; the earnings screen shows the venue settlement totals but payouts to venues are recorded there.
* Payments before this feature are not in the ledger until `reconcile_settlement` has run.

## Rollback

The migration only adds tables, an index set and one trigger function. To roll back: stop using the capabilities (revert the code), then — only if the maintainer approves removing the data —
`DROP TABLE provider_events, settlement_exceptions, settlement_holds, provider_ledger, provider_payouts, payout_accounts; DROP FUNCTION provider_ledger_append_only();`.
No existing table or row is modified. The code change in `payments/service.js` is transactional with the existing payment updates and has no effect on rows that predate the ledger.
