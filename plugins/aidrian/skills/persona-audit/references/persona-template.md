# Floor manager

<!--
A persona template for the persona-audit skill. Copy it into a knowledge bucket as <persona-id>.md, such as
floor-manager.md, tag it `personas` in the bucket's index, and replace the example with one of the product's users.
`aidrian lint personas` checks it: every section below except Voice and Evidence is required, and every task needs
a `Success:` line, an outcome someone can observe on a screen or in a response, never a feeling.
Write it from what the project knows: interviews, support tickets, data. Leave out what nobody knows.
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

Success: the number of booked guests for tonight is on the first screen after sign-in, without scrolling.

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
