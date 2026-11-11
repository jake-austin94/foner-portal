#!/usr/bin/env bash
# Creates foner's Stripe products and prices (GBP). Safe to run again: anything that already
# exists (found by its lookup key) is left alone.
#
#   foner AI receptionist   foner_monthly         £49.00 / month
#                           foner_annual          £490.00 / year   (pay 10 months, get 12)
#   Extra call minutes      foner_topup_30        £10.00 one-off   (quantity = packs of 30 minutes)
#                           foner_overage_minute  £0.30 one-off    (quantity = minutes)
#
# The Edge Functions find prices by these lookup keys, so no Stripe IDs are copied anywhere.
#
# Run it against a SANDBOX first. It shows which account it is about to use and asks before creating anything.
#   ./scripts/stripe-setup.sh          asks "Continue? [y/N]"
#   ./scripts/stripe-setup.sh --yes    skips the question (for sandboxes only)
set -euo pipefail

command -v stripe >/dev/null 2>&1 || { echo "The Stripe CLI isn't installed. Run: npm install -g @stripe/cli"; exit 1; }

# A live key in the environment is never what you want for a first run.
if [[ "${STRIPE_API_KEY:-}" =~ ^[rs]k_live_ ]]; then
  echo "STRIPE_API_KEY is a LIVE key. Run this against a sandbox first (stripe sandboxes create)."
  exit 1
fi

echo "Stripe account this will use:"
stripe whoami --format json || { echo "Not signed in. Run: stripe sandboxes create --email you@example.com  (or: stripe login)"; exit 1; }
echo

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Create foner's products and prices in this account? [y/N] " ok
  [[ "$ok" =~ ^[Yy]$ ]] || { echo "Cancelled. Nothing was created."; exit 0; }
fi

# --- helpers --------------------------------------------------------------------------------
first_match() { sed -n "s/.*\"$1\": *\"\\($2[^\"]*\\)\".*/\\1/p" | head -1; }

price_json()   { stripe prices list --lookup-keys "$1" --active=true --limit 1; }
price_exists() { [[ -n "$(price_json "$1" | first_match id price_)" ]]; }

# Reuse the product an existing price belongs to, otherwise create it.
product_for() { # <lookup_key> <name> <description>
  local pid
  pid="$(price_json "$1" | first_match product prod_)"
  if [[ -z "$pid" ]]; then
    pid="$(stripe products create --name "$2" --description "$3" | first_match id prod_)"
  fi
  [[ -n "$pid" ]] || { echo "Couldn't create or find the product '$2'"; exit 1; }
  echo "$pid"
}

make_price() { # <product> <lookup_key> <nickname> <amount_pence> [month|year]
  if price_exists "$2"; then echo "  already there: $2"; return; fi
  if [[ -n "${5:-}" ]]; then
    stripe prices create --product "$1" --currency gbp --unit-amount "$4" --lookup-key "$2" --nickname "$3" \
      -d "recurring[interval]=$5" >/dev/null
  else
    stripe prices create --product "$1" --currency gbp --unit-amount "$4" --lookup-key "$2" --nickname "$3" >/dev/null
  fi
  echo "  created:       $2"
}

# --- the plan ---------------------------------------------------------------------------------
echo "Subscription plan"
PLAN="$(product_for foner_monthly "foner AI receptionist" "AI phone receptionist for UK trade businesses. 60 call minutes a month included.")"
make_price "$PLAN" foner_monthly "Monthly" 4900 month
make_price "$PLAN" foner_annual  "Annual (pay 10 months, get 12)" 49000 year

echo "Extra call minutes"
EXTRA="$(product_for foner_topup_30 "Extra call minutes" "Additional foner call minutes beyond the 60 included each month.")"
make_price "$EXTRA" foner_topup_30        "Top-up: 30 minutes" 1000
make_price "$EXTRA" foner_overage_minute  "Extra minute" 30

echo
echo "Done. Next: save your Customer Portal settings once in the Stripe Dashboard (see BILLING.md, step 5)."
