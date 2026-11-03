# Floor manager

<!--
A persona template for the persona-audit skill. Copy it into a knowledge bucket as <persona-id>.md, such as
floor-manager.md, tag it `personas` in the bucket's index, and replace the example with one of the product's users.
`aidrian lint personas` checks it: every section below except Voice and Evidence is required, and every task needs
a `Success:` line, an outcome someone can observe on a screen or in a response, never a feeling,
in the persona's words, never a screen's name or the product's copy: `aidrian lint personas` warns on a quoted string in a Success line.

Before writing, answer these, from research rather than from the product:
1. Who is this person, in one sentence with no product term?
2. What do they want, and what is the job behind each task?
3. What would they see when a task is done, in their words?
4. What device, language, and rhythm shape their judgment?
5. Where did each answer come from?

Rules:
- Describe the person's relationship with the product: goals, familiarity, usage context, and observable outcomes.
  Never the product's screens, menu names, rules, or copy. Product rules stay in the project's `product_sensitive`
  knowledge, which a run never loads; `product-access` holds only how a session reaches the product and what it may touch.
- Start from market and user research: interviews, support tickets, data, named in Evidence.
  A persona written from the product's feature list restates the product.
- A task is a real job the person has, in their words, whether or not the product does it today.
  Keep a job the product cannot do: the walk reports it.
- One persona per person. A task whose job differs per business mode is one task per mode, each with a title that
  names the mode, such as Seat a walk-in party (tables) and Book a treatment (services).
- Who names the one familiarity the walk starts from, even when real users range wider.
- Context names the persona's language. The walk runs in it, so a Success line names the outcome, never the
  product's words: English screen text would never match a Spanish walk.
- A section the template does not name, such as Open questions, is allowed: the lint ignores it, and a run reads it as the doc's own notes.

Leave out a detail nobody knows; keep every required section.
-->

## Who

The floor manager of a busy restaurant. Comfortable with a phone and a tablet, never opens a settings page
unless something is broken, and has no time to read help text during service.

## Goals

- Seat every guest quickly, without double-booking a table.
- Know at a glance which tables are free, seated, or waiting for the bill.

## Tasks

### Seat a walk-in party

A party of four arrives without a booking during dinner service.

Success: the party shows as seated at a free table for four, and that table is no longer offered to the next booking.

### Move a booking to another table

A booked table is out of service, and its party arrives in ten minutes.

Success: the booking shows on the new table at the same time, and the old table shows as free.

### Read tonight's covers

Before service, the manager checks how busy the evening will be.

Success: the manager has tonight's booked guest count within two taps of signing in.

## Cares about

- Speed: a task done in a few taps, one-handed, while standing.
- Never seating two parties at one table.
- Plain words: "table", "party", "seated", not internal terms.

## Does not care about

- Reports, exports, and billing settings.
- How the floor plan is configured.

## Context

- Device: a tablet at the host stand, and a phone in a pocket.
- Language: Spanish first, English second.
- Uses the product every service, in short bursts between guests, often with a noisy room around.

## Voice

Short and direct. "Where is the free four-top?", "I tapped it twice and nothing happened."

## Evidence

- Five interviews with floor managers.
- The ten most frequent support tickets about seating.
