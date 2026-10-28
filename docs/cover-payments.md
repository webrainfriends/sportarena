# Cover: someone else pays your bills

A sponsor, a club or academy, a parent or a friend can pay a person's bookings, memberships, coaching sessions, health appointments, academy fees, insurance and shop orders, under an **agreement both sides approved**. It works for every individual (athlete, doctor, physio, lawyer, supplier, anyone) and for the paying side (a person, a sponsor, an organisation).

## The agreement (`cover_mandates`)
* **Who:** the person covered (beneficiary; a verified guardian acts for a young person) and the payer — a person, or an organisation (owners/admins approve and end; finance staff can also pay).
* **What:** one or more kinds of bill (`venue_invoice`, `venue_plan`, `coach_hire`, `appointment`, `physio_package`, `academy_charge`, `insurance_policy`, `shop_order`), or exactly **one bill** ("ask X to pay this").
* **How long:** `one_time`, `duration` (until a date) or `unlimited` (until someone ends it). Optional **per-bill** and **total** caps in a currency, and an optional link to the payer's **active sponsorship** of that athlete.
* **How bills reach the payer:** `auto_send` (every open bill in scope appears in the payer's inbox, and renewals notify them) or only bills the person **sends** (`send_bill_to_payer`).
* **Approval:** either side starts it (`request_cover` / `offer_cover`); the **other** side answers (`decide_cover`). You can never answer your own. A young person with a verified guardian cannot ask or answer alone; the guardian does. Either side can end it at any time (`end_cover`) and the next use is refused. Everything is logged (`cover_events`, append-only) and audit-logged.

## Paying
The payer pays at the normal checkout (`create_payment` with the bill's own `purpose_type` / `purpose_id`). Checkout recognises the agreement (live, in scope, caps and term respected, bill reached the payer) and records `payments.cover_mandate_id` and a `cover_uses` row. There are **no stored cards and no silent debits**. Because the payment keeps the bill's own type and id, receipts, fulfilment, settlement and **refunds** work unchanged — a refund goes back to whoever paid. A one-time agreement closes when its payment settles; a total cap closes it when reached; the worker marks agreements past their date `expired`. A checkout nobody finishes stops counting after 30 minutes.

## Privacy
The payer sees the **generic kind** of bill, the amount and the person's name — never the provider, the service, or any health detail (an appointment is just "Health appointment"). Only the two sides can read an agreement (anyone else gets 404). Young people are never listed when searching for a payer.

## Capabilities (REST + OpenAPI + MCP)
`request_cover`, `offer_cover`, `decide_cover`, `end_cover`, `list_cover` (`for_me` / `i_pay`), `get_cover`, `cover_inbox`, `cover_options`, `send_bill_to_payer`, `search_cover_payers`.

## App
**More → Who pays**: *Pays for me* (offers to answer, agreements, ask someone) and *I pay for others* (bills waiting with a one-tap Pay, requests to answer, offer to pay). The pay sheet has **Ask someone else to pay**: send the bill to whoever already covers you, or ask someone to pay just that bill. Terms use pickers (kinds, term chips, calendar date, currency + amount fields, switch for auto-send); people and organisations are found by searching their name.

## Limits
Refunds do not restore a total cap (a refunded payment still counts as used). Gift cards, wallet top-ups and media-rights fees are not coverable. Legal and supplier-service invoices are organisation-billed today and are not individual bills.
