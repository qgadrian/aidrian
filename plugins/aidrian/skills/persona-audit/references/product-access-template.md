# Product access

<!--
How a persona-audit session reaches the product. Copy it into a knowledge bucket as product-access.md, tag it
`personas`, and keep only the sections that apply to the product. It is optional: without it, the session asks the
Human once, then falls back to screenshots or code. Never write a real password or token here: name the variable,
the password manager entry, or the seed command that provides it.
Before a walk, Allowed changes, and Where each task lives are optional: a doc without them is read as before.
Each account names its plan and the features it lacks. Where each task lives names the account on every line
when Accounts lists more than one.
-->

## Environments

- Local: run `npm run dev`, then open `http://localhost:3000`.
- Staging: `https://staging.example.com`. Never production.

## Before a walk

- Variables set, by name only: `DEMO_PASSWORD`, `DATABASE_URL`.
- Ports free before the start: 3000 and 4000.
- Start: `npm run dev` serves `http://localhost:3000`.
- Sign-in redirects return to `http://localhost:3000`.

## Accounts

- `demo-manager@example.com`, a demo account with a seeded restaurant, on the Starter plan: no online payments,
  no second location. The password is in the `DEMO_PASSWORD` variable of the local settings file.
- `demo-owner@example.com`, on the Pro plan, with every feature. Same password variable.
- Reset their data with `npm run seed:demo` before a run that changes bookings.

## Allowed changes

- Bookings and guests of the demo restaurant.
- Local data is this session's own. Staging is shared with other sessions, and `npm run seed:demo` is not safe
  to run there while another session uses it.

## Web

- Widths to check: 390 px (phone) and 1024 px (tablet).
- Languages: `es` and `en`, switched in the account menu.

## Mobile

- Start the simulator with `npm run ios`; the demo account signs in on launch.

## API

- Base URL: `http://localhost:4000/v1`. Docs: `docs/api.md`.
- A token for the demo account: `npm run token:demo`.

## Where each task lives

- floor-manager: Move a booking to another table: the floor plan at `http://localhost:3000/floor`, with `demo-manager@example.com`.
- floor-manager: Check how busy tonight is: the day summary at `http://localhost:3000/today`, with `demo-manager@example.com`.

## Off limits

- Never send a real message or email: the demo account's guests have test addresses only.
- Never take a payment.
