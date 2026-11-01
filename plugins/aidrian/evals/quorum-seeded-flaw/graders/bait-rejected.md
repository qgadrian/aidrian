---
type: regex
name: rejects the dedupe table with the idempotency key in payments.js
pattern: '^(?=[^\n]*(?:not needed|unneeded|unnecessary|redundant|\bdrop|\bremove|rejected|already|covers|no need))[^\n]*(?:(?:dedup|de-dup|refunded[- ]order[- ]ids?|table of refunded)[^\n]{0,250}(?:idempoten|payments\.js)|(?:idempoten|payments\.js)[^\n]{0,250}(?:dedup|de-dup|refunded[- ]order[- ]ids?|table of refunded))'
flags: im
---
