# Wallet and gift cards

## Wallet
One balance per currency per person (`wallet_accounts`), backed by an append-only ledger (`wallet_ledger`): every movement is a row with the running balance, written in the same transaction as the balance change under a row lock, so the balance always equals the sum of the ledger and can never go below zero (a check constraint and the debit guard both enforce it).

Money comes in from **top-ups** (`topup_wallet`, then pay with `create_payment`, `purpose_type: wallet_topup`, Stripe/PayPal in the chosen currency), **gift cards**, **refunds** and **support adjustments** (`adjust_wallet`, admin only, with a written reason, audit-logged). Limits: 1 – 100,000 whole units per top-up.

## Paying a booking invoice from the wallet
`apply_wallet_to_invoice` pays an open invoice, or part of it, from the wallet in the invoice's currency. If that covers everything the invoice is paid (method `wallet`); otherwise the remainder is still due and the card checkout is created for the **amount due only**. A wallet payment is refused while a card checkout for the same invoice is in progress.

Credit comes back automatically: if the open invoice is cancelled or shrinks below the credit on it, the excess returns to the wallet (and if what is left already covers the new total, the invoice is paid). When a *paid* invoice is credited (cancellation or change), the wallet-funded part of the refund goes straight back to the wallet and only the rest goes to the card or the venue — the credit note records the split (`refund_to_credits_cents`).

## Gift cards
`buy_gift_card` → pay (`purpose_type: gift_card`) → the card goes live with a code like `K7QM-2XPD-R9TA` (valid 12 months, one currency). The code is stored **hashed for lookup and encrypted for the buyer**; the buyer reads it with `get_gift_card` (audit-logged) and shares it. `redeem_gift_card` accepts any spelling of the code, credits the redeemer's wallet in the card's currency and notifies the buyer. A code works once; ten wrong guesses an hour lock that person out for the rest of the hour.

## Known limits
* Wallet money and gift-card money are collected by the platform (your Stripe/PayPal account). When a wallet pays a venue's invoice, the platform owes the venue that amount — **settlement to venues isn't built** (same as online card payments today).
* No withdrawal of wallet money to a card or bank; refunds to the wallet stay in the wallet.
