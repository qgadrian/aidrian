// What a review step hands its reviewers: the input every reviewer of a pass reads, an agent pass's dispatch entry, and
// the visual capture that runs before a visual reviewer is dispatched. Each takes the step context `s` of
// lib/review/run.mjs.

import { showPrefix } from '../git.mjs';
import { fileAt, isAncestor } from './diff.mjs';
import { blocks } from './findings.mjs';
import { belowRootBrief, flowBaseBrief, remergeBrief, VERDICT_MEANING } from './reviewers.mjs';
import { recordSettled, residualTexts } from './settled.mjs';
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

// The input every reviewer of a pass reads. An exec pass also reads what is settled (lib/review/settled.mjs): the
// record's accepted findings, its own last rulings, and the raised findings a residual names among `priorFindings`, and
// the pull request body's accepted residuals as `acceptedResiduals`, so it does not re-raise them.
export function passInput(s, pass, stage) {
  const { config, root, repo, n, head, base, baseTip, changes, scope, state, plan, resultFor, sameFiles, verdictsFor, visual, manifest, isVisual, map, info } = s;
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
  const residuals = map?.[pass.reviewer]?.kind === 'exec' ? residualTexts(info?.body, config.github.pullRequest?.residuals?.section) : null;
  return {
    ...split,
    // A merge's resolutions are the whole review: a pass of every changed file reads only the resolved ones.
    pr: n, repo, base: from, head, context: from === base ? 'full' : 'delta', files: pass.files ?? (scope ? scope.changes.map((change) => change.file) : null), flows,
    priorFindings: [...(prior?.list ?? []), ...keptFindings(state, pass), ...(residuals ? recordSettled(state, prior, residuals) : [])],
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
