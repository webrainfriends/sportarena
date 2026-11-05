# Academy uniforms, kits & equipment issuance (#798)

Entitlement, fitting, issue / return / exchange, damaged-or-lost approval, deposits and replenishment for an academy's uniforms and equipment.
It is a thin layer over records that already exist; nothing here is a second stock ledger, a second fee ledger or a second console.

## Reuse / gap matrix
| Need | Source of truth (unchanged) | Gap found | Minimal additive extension (migration `157`) |
|---|---|---|---|
| SKU, size, stock, oversell guard | `inventory_items` (row-locked draw-down) | no size / product grouping / barcode / serial | nullable `style_key`, `size_label`, `kit_slot`, `barcode`, `serialised`; **a size is an ordinary stock row**, so POS, supply orders and the ledger work unchanged. `inventory_units` only for serial-numbered kit |
| Stock ledger | `pos_stock_moves` (append-only trigger) | kit reasons | reason CHECK widened (`kit_issue`, `kit_return`, `kit_exchange_out/in`, `kit_cancel`), `kit_issue_id` |
| What a family owes | `academy_charges` -> `invoices` -> payments, POS dues, `refund_academy_charge` | kit kinds | CHECK widened (`kit`, `kit_deposit`); desk, online and POS collect them exactly like any fee |
| Replenishment | `supply_orders`, `academy_suppliers`, `academy_supplier_requests` | supplier link, cost, academy-staff authority | nullable `academy_supplier_id`, `supplier_request_id`, `unit_cost_cents`, `note`, `ordered_by_org`; receiving shares one function (`src/supply-receive.js`) with the Supply screen |
| Desk staff | `posRole` (venue managers and cashiers), `opsAccess` | kit permissions | staff permissions `kit` (issue, fit, return, scan) and `kit_admin` (entitlements, orders, approvals); owners and admins hold both |
| Guardian / student view | `youth.js` live guardian link and scopes | kit read-model | `get_my_academy_kit`, receipt; guardian scope `register` to see, `pay` to see amounts. No new scope |
| Entitlements, sizes, issues | none | new | `academy_kit_entitlements`, `academy_kit_sizes` (append-only history), `academy_kit_issues`, `academy_kit_events` (append-only) |

## How it behaves
- **Entitlement** = programme, group (cohort) or squad (team) x product x quantity, either *included*, *charged* (a `kit` charge) or *loaned against a deposit* (a `kit_deposit` charge, comes back after N days). Optional: payment first, due date rule, replace-after months, collection venue and instructions, size not required.
- **Due kit is computed, not stored**: live enrolments x applicable entitlements minus what the athlete holds (a returned loan item still counts as fulfilled; a lost or damaged one does not; replace-after windows reopen it).
- **Issue** locks the enrolment, then the stock row (`FOR UPDATE`), checks, decrements and writes the ledger line in one transaction, so two desks can never issue the last unit. Serial-numbered kit picks a unit with `FOR UPDATE SKIP LOCKED`. `client_ref` makes a retry (or a race between twins) return the first result. A payment-first item is *reserved* (stock held) until its charge is paid, then *handed over*.
- **Return** puts the unit back (ledger line, serial back in stock) and releases the deposit: unpaid -> cancelled; paid at the desk -> numbered credit note; paid online -> provider refund after commit (retryable) then the same credit note. A second return is refused. Returned damaged goes to approval instead.
- **Exchange** swaps size or item in one transaction (both stock rows locked in a fixed order); the fee and deposit stay with the entitlement.
- **Damaged / lost** is a report that waits for a manager. Approving takes the unit out of circulation, keeps `forfeit_minor` of the deposit (default all), refunds the rest and can raise a replacement fee. A different manager must decide (owners/admins may decide their own, flagged in the audit trail). Rejecting restores the previous state.
- **Replenishment**: demand by product and size (athletes still owed kit) against stock on hand and on order; ordering creates one supplier request plus one supply-order line per size. Sizes that were never stocked are flagged.
- **Scanning**: `resolve_academy_kit_code` resolves a barcode, a unit serial or an issue code. The phone camera scans QR and common product barcodes; keyboard scanners type into the same field.
- **Receipts** are structured data plus a plain-text rendering with labelled lines (screen-reader friendly, shareable). Amounts only for those who may see them.

## Who sees what
| | Owner / admin | `kit_admin` | `kit` | Venue cashier (not a member) | Coach / roster staff | Guardian / adult athlete |
|---|---|---|---|---|---|---|
| Entitlements (prices), orders, approvals, finance tiles | yes | yes | no | no | no | no |
| Fit, issue, return, exchange, report, scan | yes | yes | yes | at their venue only | no | no |
| What is due, sizes, stock (no money, no fit notes, no addresses) | yes | yes | yes | at their venue | yes | own / their child's only |
| Fit notes (encrypted, reads audited) | yes | yes | no | no | no | no |
Outsiders always get `404`. Everything is read live on every call; revoking a guardian link or a permission ends access at once.

## API (REST, OpenAPI and MCP from one definition each; tag "Academy kit")
`list_academy_kit_catalogue`, `create/list/update_academy_kit_entitlement`, `set_academy_kit_size`, `get_academy_kit_sizes`, `list_academy_kit_due`, `issue_academy_kit`, `handover_academy_kit`, `cancel_academy_kit_reservation`, `return_academy_kit`, `exchange_academy_kit`, `report_academy_kit`, `decide_academy_kit_report`, `list_academy_kit_issues`, `get_academy_kit_issue`, `get_academy_kit_dashboard`, `get_academy_kit_replenishment`, `order_academy_kit_replenishment`, `update_academy_kit_order`, `add_academy_kit_units`, `resolve_academy_kit_code`, `get_my_academy_kit`, `get_academy_kit_receipt`.
Existing capabilities extended (all new fields optional): `create_inventory_item` / `update_inventory_item` (size, product key, slot, barcode, serial tracking). `adjust_stock` refuses serial-numbered items.

## App
Organisation > Academy > **Kit** (Overview, Issue & return, Entitlements, Approvals, Replenishment, Stock); the same issue desk is the **Academy kit** tab of the venue Front desk for cashiers; the family card is under My academy. One React Native codebase (iOS, iPadOS, Android, web); all text through `t()` in the 12 packs (the 11 new packs are machine-drafted, `reviewed: false`).

## Every sport
Entitlements are sport-neutral (a product is a product); `src/kit-slots.js` suggests kit slots per sport family: football/goal games, racket sports, cricket and timed/measured sports are native lists; every other sport gets the common-wardrobe list and the app says so (labelled fallback). `test/academy-kit.test.js` walks the whole sport catalogue.

## Rollback
Deploy the previous build. Migration `157` is additive and idempotent; its tables and columns are inert for the old build and its two widened CHECK constraints are supersets. No data is ever deleted: entitlements are archived, sizes are superseded, issues and events are append-only history.

## Residual limitations (explicit)
- A deposit paid in cash at the desk is refunded by credit note; the cash itself is handed back by the cashier (record it as a paid-out on the drawer). The kit module does not post drawer movements.
- A part-paid deposit must be collected or waived before the kit can be closed.
- Receipts are text and structured data; there is no PDF receipt.
- Not run on physical iOS / Android devices from this environment; verified with the web build at phone, tablet and desktop widths and `expo export` for iOS and Android.
