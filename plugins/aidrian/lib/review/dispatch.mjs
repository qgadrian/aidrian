// What a review step hands its reviewers: the input every reviewer of a pass reads, an agent pass's dispatch entry, and
// the visual capture that runs before a visual reviewer is dispatched. Each takes the step context `s` of
// lib/review/run.mjs.

import { isLogin } from '../forges/index.mjs';
import { showPrefix } from '../git.mjs';
import { refusalContext } from '../pr-product-feedback.mjs';
import { fromOutside } from '../pr-resolve.mjs';
import { stateDir } from '../project.mjs';
import { fileAt, isAncestor } from './diff.mjs';
import { blocks } from './findings.mjs';
import { belowRootBrief, flowBaseBrief, remergeBrief, VERDICT_MEANING } from './reviewers.mjs';
import { contextFindings, inputCopy, recordSettled, residualTexts } from './settled.mjs';
import { patternsOf, textChecker } from './publish.mjs';
import * as quota from './quota.mjs';
import { attachMode, captureKeys, captureVisual, capturesBody, keepUploaded, uploadCaptures, VISUAL_MARKER, signedVariants, visualInput } from './visual.mjs';
import { inBaseWorktree, runHook } from './base-worktree.mjs';

// Captures this head once, then attaches the images as the attach mode allows and writes the captures comment. The
// repository's visibility is read now, at upload time: a repository made public since the config was written stops
// uploading by itself. The mode and the visibility go in the review record, which the summary shows.
export async function captureAndAttach(s) {
  const { project, config, forge, image, captureSpawn, root, cleanEnv, repo, n, head, baseTip, onPr, comments, state, visual, visualEntries } = s;
  const manifest = await captureVisual({
    project, pr: n, head, visual, entries: visualEntries, baseUrl: config.reviewVisual?.baseUrl ?? null, env: cleanEnv,
    // A base checkout only when a hook runs: a public capture on a set base URL needs none.
    withBase: (use) => ((visual.preview && !config.reviewVisual?.baseUrl) || signedVariants(visual, visualEntries).length
      ? inBaseWorktree(root, baseTip, (tree) => use(async (command, input) => runHook(tree, command, input, cleanEnv)))
      : use(async () => { throw new Error('no hook runs here'); })),
    ...(captureSpawn ? { spawn: captureSpawn } : {}),
  });
  s.manifest = manifest;
  let visibility = null;
  try {
    visibility = forge.visibility(repo);
  } catch {}
  const mode = attachMode(visual, visibility);
  let uploadError = null;
  // The captured keys of the last few heads go in the review record, which the summary comment carries.
  state.captured = Object.fromEntries([...Object.entries(state.captured ?? {}).filter(([at]) => at !== head), [head, [...captureKeys(manifest)]]].slice(-5));
  if (mode === 'auto' && ['captured', 'partial'].includes(manifest.status)) {
    const up = uploadCaptures({ project, pr: n, manifest, uploaded: state.captures ?? {}, repo, image });
    state.captures = keepUploaded(state.captures ?? {}, up.uploaded);
    uploadError = up.error;
  }
  if (mode !== 'off' && onPr) {
    const body = capturesBody(manifest, state.captures ?? {}, { mode, visibility, error: uploadError });
    try {
      const known = comments.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(VISUAL_MARKER));
      if (known) forge.editComment(repo, known.id, body);
      else forge.postComment(repo, n, body);
    } catch (error) {
      uploadError = uploadError ?? `the captures comment was not written: ${error.message}`;
    }
  }
  state.visual = { head, status: manifest.status, mode, visibility, captured: manifest.entries.filter((entry) => entry.sha256).length, of: manifest.entries.length, ...(manifest.reason ? { reason: manifest.reason } : {}), ...(uploadError ? { error: uploadError } : {}) };
}

// Whether the step's pull request comes from inside the team, read once a step: the body's residuals are its author's
// word, so an outsider's waive nothing. The review step's CHANGE_FIELDS holds neither answer fromOutside needs. A failed
// read, or an answer it cannot read, counts as outside.
function fromInside(s) {
  if (s.inside !== undefined) return s.inside;
  try {
    const { forge, repo, n } = s;
    s.inside = fromOutside(forge.change(String(n), 'isCrossRepository', { repo })?.isCrossRepository, forge.pull(repo, n)) === false;
  } catch {
    s.inside = false;
  }
  return s.inside;
}

// { visibility, inside } for pull request `n` of `repo`, read through the forge: the visibility as the forge names it,
// or null when the read fails, and whether the pull request comes from inside the team, false on a failed read. A
// write posts the whole record only on { visibility: 'PRIVATE', inside: true } (publish.mjs isPrivate).
export function readReading(forge, repo, n) {
  let visibility = null;
  try {
    const value = forge.visibility(repo);
    visibility = typeof value === 'string' ? value : null;
  } catch {}
  let inside = false;
  try {
    inside = fromOutside(forge.change(String(n), 'isCrossRepository', { repo })?.isCrossRepository, forge.pull(repo, n)) === false;
  } catch {}
  return { visibility, inside };
}

// The names of the configs' reviewers and their agents, which the posted copy may name (publish.mjs postedCopy).
export const namesOf = (configs) => [...new Set(configs.flatMap((config) => Object.entries(config?.review?.reviewers ?? {})
  .flatMap(([key, reviewer]) => [key, reviewer?.agent]).filter((each) => typeof each === 'string')))];

// The post context of one write to the summary comment (publish.mjs postedCopy): the forge's reading of the pull
// request, a text checker in the always-on check's context (pr-product-feedback.mjs refusalContext: null when a
// knowledge index or a product-access doc cannot be read, so every string is withheld) with the public-text patterns of
// every config given and this checkout's private words, the checkout root, the reviewer names of the first config, the
// base branch's committed one, and the forge's login check. Every write of the record builds it here, so all five read the repository the same way.
export function postContext({ forge, repo, n, project, configs = [], env = process.env, reading = undefined }) {
  let context = null;
  try {
    context = refusalContext(project, { state: stateDir(project), env });
  } catch {}
  return {
    reading: reading ?? readReading(forge, repo, n),
    checker: textChecker({ context, root: project?.root ?? null, patterns: patternsOf(configs) }),
    root: project?.root ?? null,
    // Names come from the base branch's committed config alone, `configs[0]`: a checkout's edit cannot define one.
    names: namesOf(configs.slice(0, 1)),
    isLogin,
  };
}

// The accepted residuals an exec pass reads: the items of the pull request body's section, or none when the pull request
// comes from outside. Null for any other reviewer.
function passResiduals(s, pass) {
  if (s.map?.[pass.reviewer]?.kind !== 'exec') return null;
  return fromInside(s) ? residualTexts(s.info?.body, s.config.github.pullRequest?.residuals?.section) : [];
}

// The input every reviewer of a pass reads. An exec pass also reads what is settled (lib/review/settled.mjs): the
// record's accepted findings, its own last rulings, and the raised findings a residual names among `priorFindings`, and
// the pull request body's accepted residuals as `acceptedResiduals`, so it does not re-raise them. Its own last findings
// and a fallback's kept ones stay as context, with nothing on them that settles (contextFindings): only recordSettled's
// entries can waive a repeat, on any pull request. One from outside gives no residuals and so no anchors (passResiduals),
// and recordSettled still runs on it, since the record's acceptances are the team's word, not the author's. An agent pass
// never settles a repeat, so it reads its findings as recorded.
export function passInput(s, pass, stage) {
  const { config, root, repo, n, head, base, baseTip, changes, scope, state, plan, resultFor, sameFiles, verdictsFor, visual, manifest, isVisual } = s;
  const recorded = state.passes[pass.id];
  const prior = resultFor(pass) ?? (recorded && sameFiles(pass, recorded) ? recorded : null);
  const from = prior && prior.head !== head && isAncestor(root, prior.head, head) ? prior.head : base;
  const flows = plan.flows.filter((flow) => (pass.flows ?? []).includes(flow.id) || stage.name !== 'local').map((flow) => ({
    id: flow.id,
    invariants: flow.invariants,
    files: flow.files,
    ...(stage.name !== 'local' ? { earlierVerdicts: verdictsFor(flow.id) } : {}),
  }));
  const checklist = config.github.reviewGate.enabled ? config.github.reviewGate.checklist : null;
  const split = pass.role ? {
    role: pass.role,
    manifest: changes.map((change) => ({ file: change.file, status: change.status, added: change.added, removed: change.removed })),
    ...(pass.role === 'slice' ? { slice: pass.slice } : {}),
    ...(pass.role === 'cross' ? {
      slices: stage.passes.filter((each) => each.role === 'slice').map((each) => {
        const result = resultFor(each);
        return { id: each.id, slice: each.slice, files: each.files, contracts: result?.contracts ?? [], cross_notes: result?.cross_notes ?? [], findings: result?.list ?? [] };
      }),
      interfaceFiles: plan.interfaceFiles ?? [],
    } : {}),
  } : {};
  const visualChecklist = visual?.checklist ? { path: visual.checklist, text: fileAt(root, baseTip, visual.checklist.split('#')[0]) } : null;
  const residuals = passResiduals(s, pass);
  const earlier = [...(prior?.list ?? []), ...keptFindings(state, pass)];
  return {
    ...split,
    // A merge's resolutions are the whole review: a pass of every changed file reads only the resolved ones.
    pr: n, repo, base: from, head, context: from === base ? 'full' : 'delta', files: pass.files ?? (scope ? scope.changes.map((change) => change.file) : null), flows,
    priorFindings: residuals ? [...contextFindings(earlier), ...recordSettled(state, prior, residuals)] : earlier.map(inputCopy),
    ...(residuals ? { acceptedResiduals: residuals } : {}),
    ...(scope ? { remerge: head } : {}),
    // An invariant is a claim about the whole change, so a delta pass still judges its flows from the merge base:
    // judged on the delta, a narrowing an earlier push made reads as a weakening, and a new head hides a violation.
    ...(flows.length && from !== base ? { flowBase: base } : {}),
    ...(checklist ? { checklist: { path: checklist, text: fileAt(root, baseTip, checklist) } } : {}),
    ...(manifest && isVisual(pass) ? { visual: visualInput(manifest, state.captures ?? {}, visualChecklist) } : {}),
  };
}

// A fallback pass reads the open findings of the stopped reviewer's passes that finished before the stop, each with
// the pass it came from: they still block, and the fallback reviews the change knowing them.
function keptFindings(state, pass) {
  return (pass.fallback?.kept ?? []).flatMap((id) => {
    const result = state.passes[id];
    return result?.open > 0 ? (result.list ?? []).filter(blocks).map((finding) => ({ ...finding, pass: id })) : [];
  });
}

// One agent pass's entry in a `dispatch` result: who runs it, on what, and the command that records it.
export function dispatchFor(s, pass, stage) {
  const { root, n, head, map, isVisual } = s;
  const input = passInput(s, pass, stage);
  const prefix = showPrefix(root);
  const briefs = [
    prefix ? belowRootBrief(prefix) : null,
    input.checklist ? `Review the diff against the checklist in ${input.checklist.path} as well as for bugs.` : null,
    input.flows.some((flow) => (flow.invariants ?? []).some((invariant) => invariant.source)) ? 'Judge each invariant against its `source`, the section of the project doc it cites; `text` is only the question.' : null,
    input.flows.length ? VERDICT_MEANING : null,
    input.flowBase ? flowBaseBrief(input) : null,
    input.remerge ? remergeBrief(input) : null,
    input.visual ? 'Review the captures in `visual` (open each `file`), with their measured facts, as well as the diff.' : null,
    pass.fallback ? `${quota.owner(pass.fallback.replaces)} is out of quota, and the Human chose this pass as the second look in its place: review the whole change through your own lens. It is recorded as a fallback, not as an independent review.` : null,
  ].filter(Boolean);
  return {
    pass: pass.id,
    agent: pass.fallback ? pass.reviewer : map[pass.reviewer]?.agent ?? pass.reviewer,
    ...(pass.fallback ? { fallback: { replaces: pass.fallback.replaces, reason: pass.fallback.reason } } : {}),
    ...(briefs.length ? { brief: briefs.join(' ') } : {}),
    ...input,
    // A visual reviewer reports its findings one by one, so the disposition table decides what blocks.
    record: isVisual(pass)
      ? `aidrian pr attest ${n} --pass ${pass.id} --head ${head} --reviewer ${pass.reviewer} --findings-file <findings.json>${input.flows.length ? ' --verdicts <file.json>' : ''}`
      : `aidrian pr attest ${n} --pass ${pass.id} --head ${head} --reviewer ${pass.reviewer} --findings <n> --fixed <n> [--accepted <n>]${input.flows.length ? ' --verdicts <file.json>' : ''}`,
  };
}
