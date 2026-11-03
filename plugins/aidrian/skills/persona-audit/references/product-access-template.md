# Product access

<!--
How a persona-audit session reaches the product. Copy it into a knowledge bucket as product-access.md, tag it
`personas`, and keep only the sections that apply to the product. It is optional: without it, the session asks the
Human once, then falls back to screenshots or code. Never write a real password or token here: name the variable,
the password manager entry, or the seed command that provides it.
-->

## Environments

- Local: run `npm run dev`, then open `http://localhost:3000`.
- Staging: `https://staging.example.com`. Never production.

## Accounts

- `demo-manager@example.com`, a demo account with a seeded restaurant. The password is in the `DEMO_PASSWORD`
  variable of the local settings file.
- Reset its data with `npm run seed:demo` before a run that changes bookings.

## Web

- Widths to check: 390 px (phone) and 1024 px (tablet).
- Languages: `es` and `en`, switched in the account menu.

## Mobile

- Start the simulator with `npm run ios`; the demo account signs in on launch.

## API

- Base URL: `http://localhost:4000/v1`. Docs: `docs/api.md`.
- A token for the demo account: `npm run token:demo`.

## Off limits

- Never send a real message or email: the demo account's guests have test addresses only.
- Never take a payment.
