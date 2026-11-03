# Plan: merge duplicate lessons on add

## Goal

`aidrian lesson add` stops filing a lesson that repeats an open one, so the inbox does not fill with the same mistake.

## Approach

D1. On `add`, hash the note's normalised text (lowercase, collapsed whitespace) and compare it with every open lesson.
D2. On a hash match, raise the open lesson's `count` and print its ID instead of filing a new lesson.
D3. A near-duplicate, the same mistake in other words, is filed as a new lesson.

## Open questions

- D3 lets reworded repeats through. A similarity check would catch them, but could merge two different mistakes
  into one lesson, and a merged lesson loses the second session's note.
