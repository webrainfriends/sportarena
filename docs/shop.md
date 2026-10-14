# Shop

One storefront for kit, footwear and nutrition from suppliers and sponsor brands. Everything is a capability (REST + OpenAPI + MCP): `apps/api/src/capabilities/shop.js` (catalogue, listings, orders) and `shop-cart.js` (cart, checkout, wishlist). The screens are in `apps/app/src/screens/shop.js`; the cart state shared by them is `apps/app/src/shop-store.js`.

## Buying
* **Browse** (`list_products`): search (name, brand, description), category, sport, price range, offers only, in stock, minimum rating, your wishlist; sort by popular / new / best offers / price / rating. Each product carries its photos, rating, `% off` and whether you hearted it. `get_product` adds highlights, related items and `can_review`.
* **Cart** (`get_cart`, `set_cart_item`): kept on the server so it follows you across devices. Prices and stock are always read live; quantity is capped by stock; "saved for later" lines stay out of the total; removed lines keep their row (`removed_at`).
* **Checkout** (`checkout_cart`): one order per product, stock reserved atomically (if any item is gone nothing is ordered), orders share a `checkout_id`. With a payment provider on, pay everything at once: `create_payment` with `purpose_type: shop_checkout`, `purpose_id: <checkout_id>` (amount = lines still awaiting payment, read from the DB). Cancelling one line of a paid checkout refunds just that line (idempotent partial refund). The delivery address is encrypted like before. `buy_product` (single item) still works for API clients.
* **Wishlist** (`toggle_wishlist`), **reviews**: product reviews are testimonials with `subject_type: product`; only people who bought the item can write one (verified buyer), one per person.

## Selling
* `create_product` / `update_product`: photo uploads reuse the marketplace upload (`PUT /market/media`, then pass `media_ids`), plus brand, highlights and a usual price (`compare_at_cents`, must be above the price) that shows as an offer with a `% off` tag. Listings are archived (`archived_at`), never deleted; existing orders keep the price they were placed at.
* `list_products?mine=true` lists your own listings (archived included); `list_my_sales` + `update_shop_order` fulfil orders as before.

Migration `063_shop_experience.sql` is additive (new columns/tables, widened CHECK lists for `testimonials.subject_type` and `payments.purpose_type`).
