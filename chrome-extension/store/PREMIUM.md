# Preparing Forever purchases

The shipping configuration is an unlimited free preview. No production price,
payment provider, merchant account, checkout address, or signing key has been
configured. The extension cannot take payments or issue licenses by itself.

## Plan behavior

The prepared free allowance is **100 auto completes per browser profile per
local calendar day**. Successful trigger, suggestion, picker, and completed
template insertions count, including the playground. Opening or cancelling a
form, editing/exporting the library, and copying from the toolbar do not count.
Undo does not add a use or refund the original insertion. At the limit, the
trigger stays in place and a template retains its answers.

All tabs share the profile's allowance through the extension background.
Approval reserves a use before insertion; a failed insertion releases it. If
the page or browser closes before settlement, that reservation can retain one
use until midnight. The allowance uses local storage and the device clock;
clearing data, changing the clock, or using another profile can affect it.
There is no account-wide quota or claim of tamper resistance.

**Forever** means unlimited auto completes with one payment, no recurring
charge, and no license expiry. Users can retain their signed key and activate
it in their own browser installations. Activation stays local and is excluded
from snippet exports. Removing it locally does not refund a purchase. The
offline design does not prevent key sharing, revoke individual keys, enforce
device counts, or automatically react to refunds. It does not promise future
store availability or compatibility with every future browser version.

## Configure a release

1. Choose a one-time price and a payment provider, register the merchant
   account, and configure a **one-time** checkout product. Define purchase,
   refund, fulfillment, and support terms. No recurring subscription is used.
2. Generate and securely retain an ECDSA P-256 issuer private key outside the
   repository and extension packages. The issuer command accepts an
   unencrypted PEM key file; protect that file with restricted access and a
   secure backup. Never paste private keys into chat, commit them, or put them
   in browser configuration.
3. From `chrome-extension/`, derive its public JWK with the existing issuer:

   ```sh
   node scripts/issue-license.js --private-key /secure/issuer.pem --public-key
   ```

4. Edit [`src/premium-config.js`](../src/premium-config.js): keep
   `dailyLimit: 100`, put only the public JWK in `publicKeyJwk`, set the
   credential-free HTTPS `checkoutUrl`, and set `priceLabel` to the actual
   one-time price and currency. Set `enforceDailyLimit: true` only for the
   release that launches the allowance. The cap requires that flag, a public
   key that WebCrypto can import, and a valid checkout address. Checkout also
   stays unavailable without a usable verification key.
5. Verify fulfillment, activation, and the configured packages in both
   browsers before release. Update [LISTING.md](LISTING.md),
   [PRIVACY.md](PRIVACY.md), the pinned public policy URL, and the stores'
   purchase/privacy declarations with the provider and actual release behavior.

Keep the issuer key stable: this implementation trusts one public key, so
replacing it without a migration would invalidate previously issued licenses.
The private key is never needed by the extension or its background worker.

## Manual fulfillment after payment

There is no webhook, payment verification endpoint, or automatic key delivery.
Verify that a payment completed in the provider's merchant dashboard before
issuing a key; a browser success/redirect URL is not proof of payment.

From `chrome-extension/`, issue a license for an opaque order/license ID:

```sh
node scripts/issue-license.js --private-key /secure/issuer.pem --id opaque-order-id
```

The optional timestamp argument is `--issued-at YYYY-MM-DDTHH:mm:ss.sssZ`;
omitting it uses the current time. IDs accept 1–80 letters, digits, periods,
underscores, or hyphens. Do not use customer names, email addresses, or payment
details: the signed payload is readable. The command prints one
`actle1.…` token after checking it with the extension's verifier. Keep tokens
out of public logs and deliver the complete token through your chosen private
fulfillment channel.

The buyer opens **Plans & support → Already have a license?**, pastes the token,
and selects **Activate license**. Verification uses the packaged public key
and works offline. Reloading must preserve the **Forever** plan. Ask the buyer
to keep their token for another installation; removing it only affects the
current browser profile.

Before accepting real payments, verify a provider sandbox purchase, issuance,
delivery, activation, and the documented refund process. The repository's
automated tests use temporary generated keys and isolated configured packages;
they do not verify a real merchant account, charge, or delivery service.
