// A reviewer out of quota: what the review step records, the question it asks the Human, and what replaces the stopped
// pass once the Human picks. A quota stop is recorded on the head it hit (`state.quotaStops`); the Human's choice holds
// for that head only, so a later push runs the reviewer again. Two choices replace the stopped passes:
//   agent:<name>  one read-only agent pass, the critic by default: a second look on the session's own model
//   human         the Human reviews the change and signs the stage off, `aidrian pr signoff <PR> --stage <name>`
// A pass of the stopped reviewer that finished before the stop, such as one slice of a split, stays: its findings still
// block, and the fallback reads them as `priorFindings`.
// Neither is an independent review: a plan that requires `independent-model` keeps waiting for the quota.
// docs/review.md#out-of-quota describes it; lib/rules/review-fallback.mjs guards the choice.

import { satisfies } from './reviewers.mjs';

export const HUMAN = 'human';
export const AGENT = /^agent:([a-z0-9][a-z0-9-]*)$/u;
export const DEFAULT_AGENT = 'critic';
// The labels the Human picks from; lib/rules/review-fallback.mjs reads the answer by them. An agent's label names the
// agent, so the answer authorizes that agent only.
export const agentLabel = (name) => `Run a ${name} agent`;
export const LABELS = Object.freeze({ agent: agentLabel(DEFAULT_AGENT), human: 'The Human reviews it', wait: 'Wait for quota' });
// The most stops the record keeps.
const KEEP = 10;

// `--quota-fallback`'s value, checked: `human` or `agent:<name>`.
export function parseChoice(value) {
  if (value === HUMAN || AGENT.test(value ?? '')) return value;
  throw new Error('--quota-fallback must be "agent:<name>", such as agent:critic, or "human"');
}

// Whose quota ran out, in words: the review bot's quota notice is Codex's (lib/pr-await-review.mjs).
export const owner = (reviewer) => (reviewer === 'codex-local' || reviewer === 'pr-bot' ? 'Codex' : `the ${reviewer} reviewer`);

export const fallbackPassId = (stop, agent) => `fallback:${stop.stage}:${stop.reviewer}:${agent}`;

// The record's stops on `head` for `stage`, one per reviewer.
export const stopsFor = (state, head, stage) => (state.quotaStops ?? []).filter((each) => each.stage === stage && each.head === head);

export const signoffCommand = (pr, stop) => `aidrian pr signoff ${pr} --stage ${stop.stage} --head ${stop.head}`;

// The stop of `pass`'s reviewer in `stage` on `head`, put on the record in place of an earlier one for the same head,
// stage, and reviewer: another reviewer's stop in the stage, and the choice made for it, stay. Every pass of that
// reviewer in the stage stops with it, the slices and the cross pass of a split included.
export function recordStop(state, { head, stage, pass, reason }) {
  const stop = {
    head, stage: stage.name, reviewer: pass.reviewer, passes: stage.passes.filter((each) => each.reviewer === pass.reviewer).map((each) => each.id),
    reason: String(reason ?? '').replace(/\s+/gu, ' ').slice(0, 300), at: new Date().toISOString(), choice: null,
  };
  const same = (each) => each.head === head && each.stage === stop.stage && each.reviewer === stop.reviewer;
  state.quotaStops = [...(state.quotaStops ?? []).filter((each) => !same(each)), stop].slice(-KEEP);
  return stop;
}

// Why no fallback may replace `stop`, or null: a plan that requires an independent model, which no other pass gives.
export function refusal(plan, stop, passes, map) {
  if (!(plan.require ?? []).includes('independent-model')) return null;
  if (satisfies('independent-model', passes.filter((pass) => pass.reviewer !== stop.reviewer), map)) return null;
  return `the plan requires an independent model, and ${owner(stop.reviewer)} is out of quota: neither a same-model agent nor the Human's sign-off counts as one, so the review waits for the quota. A later push, or this step run again once the quota is back, runs it again`;
}

// The one question for the Human, with the options recommended first, and the command each option runs.
export function question({ pr, stop, withBot = false }) {
  const who = owner(stop.reviewer);
  const run = (choice) => `aidrian pr review ${pr}${withBot ? ' --with-bot' : ''} --quota-fallback ${choice}`;
  return {
    question: `${who} is out of quota, so the ${stop.stage} review of pull request #${pr} stopped on head ${stop.head.slice(0, 7)}. How should the second look happen? Either fallback is recorded as a fallback, never as an independent review.`,
    options: [
      { label: `${LABELS.agent} (Recommended)`, description: 'A read-only critic agent reviews the whole change now, faster for a bigger change. Recorded as a same-model fallback, not an independent review.', run: run(`agent:${DEFAULT_AGENT}`) },
      { label: LABELS.human, description: 'The Human reviews the change, then signs this stage off with a command in their own shell. Recorded as the Human\'s sign-off, not an independent review.', run: run(HUMAN) },
      { label: LABELS.wait.replace('quota', `${who === 'Codex' ? 'Codex' : `${who}'s`} quota`), description: `Stop here. A later push runs ${who} again.`, run: null },
    ],
  };
}

// The plan with the Human's choice in place of every stopped pass on `head`: an agent choice adds one fallback pass, a
// human choice leaves the stage to the Human's sign-off. A pass of the stopped reviewer that `finished` (it has a
// result that counts on this head) stays, marked `beforeQuota`, so its open findings still block, and the fallback pass
// names it in `kept`. Returns the stops applied.
export function applyChoices(plan, stops, head, finished = () => false) {
  const applied = [];
  for (const stop of (stops ?? []).filter((each) => each.head === head && each.choice)) {
    const stage = plan.stages.find((each) => each.name === stop.stage);
    if (!stage) continue;
    const kept = stage.passes.filter((pass) => pass.reviewer === stop.reviewer && finished(pass));
    for (const pass of kept) pass.beforeQuota = true;
    stage.passes = [...stage.passes.filter((pass) => pass.reviewer !== stop.reviewer), ...kept];
    const agent = AGENT.exec(stop.choice)?.[1];
    if (agent) stage.passes.push({ id: fallbackPassId(stop, agent), reviewer: agent, kind: 'agent', files: null, context: 'full', fallback: { replaces: stop.reviewer, reason: stop.reason, kept: kept.map((pass) => pass.id) } });
    applied.push(stop);
  }
  return applied;
}

// One plain sentence on what a stop led to, for the summary comment and the step's result.
export function describe(stop) {
  const who = owner(stop.reviewer);
  const at = `\`${String(stop.head).slice(0, 7)}\``;
  const agent = AGENT.exec(stop.choice ?? '')?.[1];
  const not = 'This is not an independent review.';
  if (agent) return `${who} was out of quota on ${at}, so the ${stop.stage} stage ran on a fallback the Human chose: the ${agent} agent, on the session's own model. ${not}`;
  if (stop.choice === HUMAN && stop.signoff) return `${who} was out of quota on ${at}, so the Human reviewed the ${stop.stage} stage instead, signed off by ${stop.signoff.by} (an audit entry, not proof). ${not}`;
  if (stop.choice === HUMAN) return `${who} was out of quota on ${at}, so the Human chose to review the ${stop.stage} stage; their sign-off is needed. ${not}`;
  return `${who} was out of quota on ${at}, and the ${stop.stage} stage stopped: nothing replaced it. A later push runs it again.`;
}

// The summary comment's lines on the latest stops: a blank line, then one line per stop; nothing when there is none.
export function summaryLines(state) {
  const stops = (state.quotaStops ?? []).slice(-5);
  return stops.length ? ['', ...stops.map((stop) => `- ${describe(stop)}`)] : [];
}
