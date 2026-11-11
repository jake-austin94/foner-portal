# foner billing (Stripe)

Customers pay through Stripe at the end of their free month. Stripe holds the money, the cards and the invoices; the portal shows the status and sends people to Stripe's own pages. **Status: written and tested in isolation, not yet deployed or run against Stripe.** Follow the steps below, in a sandbox first.

## How it works

```
Customer taps "Pay monthly / yearly" in app.foner.uk → Account
   └─ function stripe-checkout   makes the Stripe customer (first time) + a Checkout link → Stripe's payment page
Stripe tells us what happened
   └─ function stripe-webhook    checks the signature, updates the `billing` table, raises alerts
Customer taps "Manage billing"
   └─ function stripe-portal     opens Stripe's Customer Portal (card, invoices, switch plan, cancel)
Top-ups (admin only, Account page)
   └─ function stripe-invoice-item   adds a 30-minute top-up (£10) to the customer's invoice
```

| Piece | Where |
|---|---|
| Tables `billing`, `stripe_events`, `billing_alerts`, `billing_charges` | `supabase/migrations/20261111120000_stripe_billing.sql` |
| Functions | `supabase/functions/stripe-checkout`, `stripe-portal`, `stripe-webhook`, `stripe-invoice-item` |
| Webhook decisions (tested) | `supabase/functions/stripe-webhook/logic.js` and `logic.test.mjs` |
| Product and price setup | `scripts/stripe-setup.sh` |
| Screens | `app.js`: Account → Billing; Admin → Billing alerts |

**What you sell** (GBP): foner AI receptionist at £49/month (`foner_monthly`) or £490/year (`foner_annual`); 30-minute top-up £10 (`foner_topup_30`). There is no per-minute overage charge. Functions find prices by these lookup keys, so no Stripe IDs are copied anywhere.

## Set-up (about 20 minutes)

Do this on your own computer, in a sandbox first. Never paste a secret key into chat, code or a file in this repo.

1. **Create a sandbox.** `stripe sandboxes create --email foner.uk@gmail.com`. It saves test keys to your CLI and gives you a claimable test account (a sandbox is Stripe's isolated test environment). Use this rather than the account's shared test mode.
2. **Create the products and prices.** `./scripts/stripe-setup.sh`. It shows which account it will use and asks before creating anything. Safe to run again.
3. **Make a restricted key** (Dashboard, in the sandbox → Developers → API keys → Create restricted key, name it `foner-portal`). Give it only: Customers (write), Checkout Sessions (write), Customer portal (write), Subscriptions (read), Prices (read), Charges (read), Invoices (write), Invoice items (write). It starts `rk_test_`. It is shown once.
4. **Give Supabase the key.** In your terminal (not in a file that gets committed):
   `supabase secrets set STRIPE_SECRET_KEY=rk_test_... --project-ref lkfriflskqyvwaknzbet`
   Optional: `SITE_URL` (defaults to `https://app.foner.uk`).
5. **Save your Customer Portal settings once** (Dashboard → Settings → Billing → Customer portal): allow updating payment method, invoice history, cancelling at the end of the period, and switching between the two foner prices. Click Save. Without a saved configuration, "Manage billing" returns an error.
6. **Apply the migration.** Run the SQL in `supabase/migrations/20261111120000_stripe_billing.sql` (Supabase → SQL editor, or `supabase db push`).
7. **Deploy the functions.**
   `supabase functions deploy stripe-checkout stripe-portal stripe-invoice-item --project-ref lkfriflskqyvwaknzbet`
   `supabase functions deploy stripe-webhook --no-verify-jwt --project-ref lkfriflskqyvwaknzbet`
   The webhook must be deployed **without** JWT verification: Stripe isn't a signed-in user, and the Stripe signature is its authentication.
8. **Point Stripe at the webhook.** Dashboard (sandbox) → Developers → Webhooks → add endpoint `https://lkfriflskqyvwaknzbet.supabase.co/functions/v1/stripe-webhook`, subscribed to exactly these events (no others):
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.dispute.created`, `charge.refunded`, `radar.early_fraud_warning.created`.
   Copy its signing secret (`whsec_...`) and run `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --project-ref lkfriflskqyvwaknzbet`.

## Test it (sandbox)

1. Sign in to the portal as a test business, open Account → Billing, tap **Pay monthly**. Pay with test card `4242 4242 4242 4242`, any future date, any CVC.
2. You return to the Account page; within a few seconds it should say **Your plan is active** with the next payment date.
3. Tap **Manage billing**: you should land on Stripe's portal.
4. As an admin, try **Add 30-minute top-up**, then check the sandbox's Customers → upcoming invoice.
5. Try the failure paths with Stripe's test cards ([docs.stripe.com/testing](https://docs.stripe.com/testing)): one that fails the charge shows up under Admin → Billing alerts, and one that triggers a dispute does the same. A later successful payment clears the failed-payment alert.
6. Check `stripe_events`: every event should have a `processed_at` and no `error`.

Local development: `stripe listen --forward-to https://lkfriflskqyvwaknzbet.supabase.co/functions/v1/stripe-webhook` prints a temporary `whsec_` secret to use while you test.

## Before going live

- **Show Billing to customers.** Until then only foner admins see it. In `app.js`, set `BILLING_ADMINS_ONLY` to `false` (do this only with live keys in place).
- Repeat steps 3 to 8 with a **live** restricted key (`rk_live_`), a live webhook endpoint (its own `whsec_`) and live portal settings. Run `stripe-setup.sh` against the live account too. Don't reuse test keys or secrets.
- Add an access policy (IP restriction) to the live key, and turn on passkey or authenticator 2FA for your Stripe login (not SMS).
- Walk through Stripe's [go-live checklist](https://docs.stripe.com/get-started/checklist/go-live).
- If a key is ever exposed, roll it straight away in the Dashboard, then check the request logs.

## Decisions and limits to know about

- **The free month is not in Stripe.** Nothing exists in Stripe until the customer taps Pay, and they are charged straight away at that point. The "free month runs until..." line comes from `clients.trial_ends_at`.
- **Payment links expire after 24 hours.** In the end-of-trial email, link to `https://app.foner.uk` (customers tap Pay there for a fresh link). The admin "Copy payment link" buttons are for sending someone a link right now.
- **Top-ups.** A top-up is a Stripe invoice item. A monthly subscriber's goes on their next invoice. An annual subscriber's next invoice could be a year away, so they're invoiced straight away instead. Tapping twice can't bill twice. Nothing is charged automatically when a customer goes over their minutes (no per-minute charge), and the receptionist keeps answering.
- **"A month with no new enquiry is free"** isn't automated. Give that customer a credit or a 100%-off coupon in Stripe.
- **Tax.** If you charge UK VAT (now, or once you pass the threshold), look at Stripe Tax alongside Billing. It collects nothing until you've added an active registration, so leave `automatic_tax` off until then; see [Collect taxes for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes.md).
- **Not built yet:** moving a customer to "paying" in the Ads funnel (`site_leads.paid_at`) when they subscribe; an automatic end-of-trial email (the n8n workflow is untouched); metered billing through Metronome (not needed for one plan).
