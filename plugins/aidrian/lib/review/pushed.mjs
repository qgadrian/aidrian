// The head a review step reviews. The forge can report the commit a push built on for a while after the push, and a
// step that reviewed that commit re-served its round's result and findings as if the push had not happened. So when
// this checkout's branch tracks the pull request's branch, two local facts win over a stale report, the same rule
// `aidrian pr await-review` follows: an upstream commit the reported head is a strict ancestor of is the pull
// request's real head, and a local commit past that one is work not pushed yet, which the step names instead of
// reviewing the older head. A checkout on any other branch, such as one stacked on the pull request, reads the report.

import { runGit } from '../git.mjs';
import { isAncestor } from './diff.mjs';

const line = (root, args) => {
  const result = runGit(args, root);
  return result.status === 0 ? result.stdout.trim() || null : null;
};

// { head, unpushed? }: `head` is the commit to review, `unpushed` this checkout's HEAD when it is past that commit.
export function headToReview(root, reported, branch) {
  const local = branch ? line(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : null;
  if (!local || line(root, ['config', `branch.${local}.merge`]) !== `refs/heads/${branch}`) return { head: reported };
  const ahead = (from, to) => Boolean(from && to) && from !== to && isAncestor(root, from, to);
  const upstream = line(root, ['rev-parse', '--verify', '--quiet', '@{u}']);
  const head = ahead(reported, upstream) ? upstream : reported;
  const checkedOut = line(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return ahead(head, checkedOut) ? { head, unpushed: checkedOut } : { head };
}
