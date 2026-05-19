// Pricing constants for MI Little Care.

/**
 * The MI Little Care provider subscription price, as shown to users.
 *
 * This is **display copy only** — it is not what Stripe actually
 * charges. The amount charged at checkout is the Stripe Price object
 * referenced by the `STRIPE_PRICE_ID` environment variable in Vercel
 * (used by `api/create-checkout-session.js`).
 *
 * ⚠️ These two are NOT linked. Whenever the Stripe Price changes, this
 * constant must be updated by hand to match — otherwise the UI will
 * advertise one price while Stripe charges another. See
 * `docs/tech_debt.md` § "Displayed subscription price is loosely
 * coupled to the Stripe Price".
 */
export const SUBSCRIPTION_PRICE_DISPLAY = '$34.99'
