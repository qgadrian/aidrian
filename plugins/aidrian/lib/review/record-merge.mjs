// Two records of one pull request that grew apart on this machine, as when a session on an older plugin keeps writing the
// review record under its old name while a newer one writes the repository's own file (state.mjs readLocalState,
// writeAt), or a newer copy on the pull request was built by a writer that never read this machine's record
// (state.mjs readRecord). Neither may lose what the other holds of the Human: a sign-off, an overrule, an acceptance, a
// waiver, an extension, or a stage sign-off is the Human's word, and nothing in the engine takes one back.
// keepHuman adds those; keepWork adds the review's own progress, the passes, rounds, and id counter, for two copies of
// one record on one machine. Each mutates and returns `base`, so a caller that writes or posts it carries the result.
// Both act only on two copies of one review, the same first round (sameReview): a review that started over, from an
// empty record, dropped the earlier review's entries on purpose, as an override line is filled only into its own review.

import { isObject } from '../fs.mjs';
import { STOPS_KEPT } from './quota.mjs';

const list = (state, key) => (Array.isArray(state?.[key]) ? state[key].filter(isObject) : []);
const later = (a, b) => String(b?.at ?? '') > String(a?.at ?? '');
const keyOf = (entry, keys) => JSON.stringify(keys.map((key) => entry[key] ?? null));
const sameHead = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && (a.startsWith(b) || b.startsWith(a));

// Whether `a` and `b` are copies of one review: the same first round, by its head and time.
export function sameReview(a, b) {
  const [ours, theirs] = [a?.rounds?.[0], b?.rounds?.[0]];
  return isObject(ours) && isObject(theirs) && sameHead(ours.head, theirs.head) && ours.at === theirs.at;
}

// The Human's entries of `other` that `base` lacks, added to `base`. A flow's sign-off and an overrule or acceptance of one
// invariant on one head keep the later of the two; the other lists gain each entry they do not hold.
export function keepHuman(base, other) {
  if (!isObject(base) || !isObject(other) || !sameReview(base, other)) return base;
  if (!isObject(base.signoffs)) base.signoffs = {};
  for (const [flow, signoff] of Object.entries(isObject(other.signoffs) ? other.signoffs : {})) {
    if (isObject(signoff) && (!isObject(base.signoffs[flow]) || later(base.signoffs[flow], signoff))) base.signoffs[flow] = { ...signoff };
  }
  keepLatest(base, other, 'overrulings', ['flow', 'invariant', 'head']);
  keepLatest(base, other, 'acceptances', ['flow', 'invariant', 'head']);
  keepEach(base, other, 'waivers', ['head', 'kind', 'at']);
  keepEach(base, other, 'extensions', ['source', 'round', 'head', 'at']);
  const overrides = Array.isArray(other.overrides) ? other.overrides.filter((line) => typeof line === 'string') : [];
  if (overrides.length) base.overrides = [...new Set([...(Array.isArray(base.overrides) ? base.overrides : []), ...overrides])];
  keepStops(base, other);
  return base;
}

// The review's progress `other` holds that `base` lacks, added to `base`: each pass it alone holds, or the one on the
// head `base` last reviewed where `base`'s pass is on another; each round past `base`'s last; the higher id counter, so no
// id is minted twice; and the higher revision and later write time, so the result is the newer record.
export function keepWork(base, other) {
  if (!isObject(base) || !isObject(other) || !sameReview(base, other)) return base;
  const current = base.planNote?.head ?? base.rounds?.at(-1)?.head ?? null;
  if (!isObject(base.passes)) base.passes = {};
  for (const [id, pass] of Object.entries(isObject(other.passes) ? other.passes : {})) {
    const ours = base.passes[id];
    if (!isObject(pass)) continue;
    if (!isObject(ours) || (current !== null && pass.head === current && ours.head !== current)) base.passes[id] = pass;
  }
  const rounds = Array.isArray(other.rounds) ? other.rounds : [];
  if (Array.isArray(base.rounds) && rounds.length > base.rounds.length) base.rounds = [...base.rounds, ...rounds.slice(base.rounds.length)];
  if (Number.isSafeInteger(other.idCounter) && other.idCounter > (Number.isSafeInteger(base.idCounter) ? base.idCounter : 0)) base.idCounter = other.idCounter;
  base.revision = Math.max(base.revision ?? 0, other.revision ?? 0);
  if (String(other.updatedAt ?? '') > String(base.updatedAt ?? '')) base.updatedAt = other.updatedAt;
  return base;
}

// The Human's choice of what replaces a reviewer out of quota, and the stage sign-off that answers it, from `other`'s
// quota stops onto `base`'s. A stop is one per head, stage, and reviewer (quota.mjs recordStop), and the choice, its time,
// and the sign-off travel together: the review step clears the sign-off when the Human changes the choice
// (step.mjs), and a stage counts as signed only on a stop whose choice is the Human's (record.mjs recordStageSignoff).
// - The same stop, by its time, in both: the later choice, by `chosen_at`, with its own sign-off; where both hold one
//   choice, the later sign-off.
// - A stop only `other` holds, with a choice or a sign-off: added, unless `base` holds a later stop for that head, stage,
//   and reviewer, which a stop recorded again replaced on purpose, its choice with it. A push leaves a stop on its
//   own head, where nothing reads it for the new head, so a stop of an earlier head is kept, not revived for a later one.
// - At most the latest STOPS_KEPT, by time, as recordStop keeps: a stop `base` let go for being old stays gone.
function keepStops(base, other) {
  const theirs = list(other, 'quotaStops').filter((stop) => chosen(stop) || isObject(stop.signoff));
  if (!theirs.length) return;
  const ours = list(base, 'quotaStops');
  const slot = (a, b) => sameHead(a.head, b.head) && a.stage === b.stage && a.reviewer === b.reviewer;
  for (const stop of theirs) {
    const same = ours.find((each) => slot(each, stop) && each.at === stop.at);
    if (same) {
      takeChoice(same, stop);
      continue;
    }
    if (ours.some((each) => slot(each, stop) && String(each.at ?? '') > String(stop.at ?? ''))) continue;
    const replaced = ours.filter((each) => slot(each, stop));
    for (const each of replaced) ours.splice(ours.indexOf(each), 1);
    ours.push({ ...stop, ...(isObject(stop.signoff) ? { signoff: { ...stop.signoff } } : {}) });
  }
  base.quotaStops = ours.map((stop, i) => [stop, i]).sort(([a, i], [b, j]) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || i - j)
    .map(([stop]) => stop).slice(-STOPS_KEPT);
}

const chosen = (stop) => typeof stop?.choice === 'string' && stop.choice !== '';

// `stop`'s choice, its time, and its sign-off, from `theirs` where it chose later or `stop` chose nothing; where both
// made one choice at one time, `theirs`'s sign-off where it is the later or `stop` has none.
function takeChoice(stop, theirs) {
  const [ourAt, theirAt] = [String(stop.chosen_at ?? ''), String(theirs.chosen_at ?? '')];
  if (chosen(theirs) && (!chosen(stop) || theirAt > ourAt)) {
    Object.assign(stop, { choice: theirs.choice, chosen_at: theirs.chosen_at ?? null, signoff: isObject(theirs.signoff) ? { ...theirs.signoff } : null });
    return;
  }
  if (stop.choice !== theirs.choice || ourAt !== theirAt || !isObject(theirs.signoff)) return;
  if (!isObject(stop.signoff) || later(stop.signoff, theirs.signoff)) stop.signoff = { ...theirs.signoff };
}

// `base[key]` with each entry of `other[key]` whose `keys` it does not hold, and, where both hold one, the later.
function keepLatest(base, other, key, keys) {
  const theirs = list(other, key);
  if (!theirs.length) return;
  const out = new Map(list(base, key).map((entry) => [keyOf(entry, keys), entry]));
  for (const entry of theirs) {
    const at = keyOf(entry, keys);
    if (!out.has(at) || later(out.get(at), entry)) out.set(at, { ...entry });
  }
  base[key] = [...out.values()];
}

// `base[key]` with each entry of `other[key]` whose `keys` it does not hold.
function keepEach(base, other, key, keys) {
  const theirs = list(other, key);
  if (!theirs.length) return;
  const held = new Set(list(base, key).map((entry) => keyOf(entry, keys)));
  base[key] = [...(Array.isArray(base[key]) ? base[key] : []), ...theirs.filter((entry) => !held.has(keyOf(entry, keys))).map((entry) => ({ ...entry }))];
}
