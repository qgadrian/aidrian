// What the forge holds a project run's issue session to, beyond the hooks: a rule that asks for a pull request on the
// default branch, a tag rule over every tag, and no CI secret a branch's workflows can read, each unless the team accepts
// running without it (projectRun.forgeProtectionAccepted, projectRun.workflowSecretsAccepted). The preflight prints them
// as lines (holdLines, lib/project-preflight.mjs); every start asks them again (holdsProblem, lib/project-run-gate.mjs),
// with the very token it hands the issue session where the host hands one, so a protection changed since the preflight,
// or read for another account than the token's, starts nothing. Every read is the forge adapter's own (refProtection,
// workflowSecrets), with `token` and the pinned repository's host when given.

// What a `note` says in place of a branch-protection or release-tags blocker the team accepts through
// projectRun.forgeProtectionAccepted.
const ACCEPTED_PROTECTION = 'the team accepts no forge protection (projectRun.forgeProtectionAccepted): a script an issue session runs can push to the default branch or a tag with the token, and only the hooks hold it';
// How a team accepts the workflow secrets risk, in every line that names the key: it skips the secrets read whole, so it
// accepts the secrets of the repository, its organization, and every environment, today's and any added later.
export const SECRETS_ACCEPTED = 'projectRun.workflowSecretsAccepted on the default branch skips the workflow secrets read whole: it accepts all current and future workflow secret exposure for project runs, the repository\'s, its organization\'s, and every environment\'s secrets, so a team sets it only when that is acceptable';
// The permissions a fine-grained token needs for these reads, named when a read with the session's token fails.
const TOKEN_PERMISSIONS = 'a fine-grained token needs Administration: Read-only, Secrets: Read-only, and Environments: Read-only for these reads';

// The lines of what guards the default branch, the tags, and the CI secrets from the token an issue's session keeps,
// through the forge's own reads (refProtection, workflowSecrets) of the pinned `repository` ({ host, owner, name }),
// with `token` when given, else the forge CLI's own login: `check(name, problem)` for a blocker or an `ok`, `failed(name,
// why)` for a read the forge could not answer (a blocker in the preflight, a retry at a start), `asks` for what the forge
// cannot say, and notes pushed to `lines`. A blocker when no rule that asks for a pull request on the default branch
// binds the signed-in user, an `ask` when the forge shows such a rule only to an administrator, and a blocker when no
// active tag rule that user may never bypass names every tag and restricts creating and updating one; a forge whose plan
// offers no such rule names the plan in both. When the team sets projectRun.forgeProtectionAccepted (as teamPolicy reads
// it, on the forge and the local ref both), each of those is a `note` naming the risk the team took instead. Then the
// workflow secrets (secretsLines), and, with `notes`, the preflight's notes on what the forge runs.
export function holdLines({ facade, repository, policy, token = null, lines, check, failed = check, asks, notes = true }) {
  const named = repository ? `${repository.owner}/${repository.name}` : null;
  const accepted = policy.forgeProtectionAccepted === true;
  const guard = (name, problem) => {
    if (problem && accepted) lines.push(`note ${name}: ${ACCEPTED_PROTECTION}`);
    else check(name, problem);
  };
  const reads = token ? { host: repository.host, token } : { host: repository?.host };
  const permissions = token ? `; ${TOKEN_PERMISSIONS}` : '';
  if (typeof facade.refProtection === 'function' && named) {
    let read = null;
    try {
      read = facade.refProtection(named, reads);
    } catch (error) {
      const why = `the forge cannot say what guards the default branch and the tags (${String(error.message).split('\n')[0]})${permissions}; check them on the forge and add the rules the run needs, or the default branch sets projectRun.forgeProtectionAccepted`;
      const unanswered = accepted ? guard : failed;
      unanswered('branch-protection', why);
      unanswered('release-tags', why);
    }
    if (read?.plan === true) {
      const plan = `the forge offers no rule for this repository, since ${read.why}, so nothing holds the signed-in user, whose token an issue's session keeps, from pushing to the default branch ${read.branch} or a tag, and a script it runs could; move to a plan that offers them, or make the repository public, then add the rules, or the default branch sets projectRun.forgeProtectionAccepted to run with only the hooks holding it`;
      guard('branch-protection', plan);
      guard('release-tags', plan);
    } else if (read) refLines({ read, accepted, guard, asks });
  } else if (accepted) lines.push(`note protection: ${ACCEPTED_PROTECTION}`);
  else asks.push('ask protection: confirm on the forge that the default branch asks for a pull request of the signed-in user, admin or not, and that a tag rule the signed-in user cannot bypass stops a tag being created or moved; a missing one is a blocker, unless the default branch sets projectRun.forgeProtectionAccepted');
  secretsLines({ facade, named, reads, permissions, policy, check, failed, asks });
  if (!notes) return;
  lines.push(`note workflows: the forge runs a branch's own workflow files, and the code they call, with the repository's secrets on every push, and an issue's session pushes its branch: keep release and deploy secrets in environments held for a reviewer who prevents self-review or is not the signed-in user; an environment limited to protected branches or branch patterns counts as open, since a deployment branch rule is no hold against code the run pushes; ${SECRETS_ACCEPTED}; a token without the workflow scope keeps the session from changing a workflow file, not from changing the tests and scripts a workflow runs; a cloud role trusted through OIDC federation for any ref of the repository (a subject such as repo:<owner>/<name>:*) can be assumed from any branch, so limit its trust to a protected branch, or to an environment held as above; the hook refuses an issue session's writes to the workflow files and a push whose commits change them, and a script it runs is the residual`);
  lines.push('note triggers: other services that act on a push or a pull request comment, such as preview deploys and ChatOps bots, run for an issue\'s branch too, with their own secrets; keep them to protected branches or reviewed pull requests');
}

// The branch-protection and release-tags lines of the forge's read `read` (refProtection), through `guard`, which
// turns a blocker into a note when the team accepts it (`accepted`), and `asks`. An administrator's token can turn off or
// edit any rule of the repository, so no rule holds it.
function refLines({ read, accepted, guard, asks }) {
  const admin = read.admin === true;
  const branchFix = admin ? ADMIN_FIX : 'protect it with a rule that asks for a pull request, includes administrators, and lets that user bypass nothing';
  if (read.protected === null && accepted) guard('branch-protection', read.why);
  else if (read.protected === null) asks.push(`ask branch-protection: confirm on the forge that the default branch ${read.branch} asks for a pull request of the signed-in user too, since ${read.why}; a missing one is a blocker, unless the default branch sets projectRun.forgeProtectionAccepted`);
  else guard('branch-protection', read.protected ? null : `no rule on the forge holds the signed-in user, whose token an issue's session keeps, to a pull request on the default branch ${read.branch} (${read.why}), so a script it runs could push to it; ${branchFix}, before the run, or the default branch sets projectRun.forgeProtectionAccepted`);
  if (admin) {
    guard('release-tags', `no tag rule on the forge holds the signed-in user, whose token an issue's session keeps, since ${ADMIN_WHY}, so a script it runs could push a release tag; ${ADMIN_FIX}, before the run, or the default branch sets projectRun.forgeProtectionAccepted`);
    return;
  }
  const held = read.tags.filter((rule) => rule.all && rule.creation && rule.update && rule.bypass === 'never');
  guard('release-tags', held.length ? null : 'no active tag rule on the forge names every tag and stops the signed-in user, whose token an issue\'s session keeps, creating or moving one, so a script it runs could push a release tag; add a tag ruleset over all tags (~ALL or refs/tags/**/*, excluding none; refs/tags/* stops at a slash) that restricts creations and updates, with no bypass for that user, before the run, or the default branch sets projectRun.forgeProtectionAccepted');
}

// Why no rule holds an administrator's token, and how the run gets one that does: the token can turn off branch
// protection's "include administrators" and edit any ruleset's bypass list, which the forge reads as held.
const ADMIN_WHY = 'the signed-in user administers the repository, and that token can turn off or edit any rule on it, its bypass list included';
const ADMIN_FIX = 'give the issue sessions the token of an account that may push but does not administer the repository, held by a rule that asks it for a pull request and lets it bypass nothing';

// The workflow secrets check: a blocker when the repository's workflows see CI secrets, unless the default branch sets
// projectRun.workflowSecretsAccepted (as teamPolicy reads it, on the forge and the local ref both); an `ask` for a forge
// with no such read. Whatever the token's scopes: the forge runs the existing push and pull request workflows on an
// issue's branch, and they run the branch's own code, its tests, scripts, and build, with their secrets. A token that
// may push a change to a workflow file widens that, and one that may not narrows it, which the blocker says.
function secretsLines({ facade, named, reads, permissions, policy, check, failed, asks }) {
  if (policy.workflowSecretsAccepted === true) {
    check('workflow-secrets', null);
    return;
  }
  if (typeof facade.workflowSecrets !== 'function' || !named) {
    asks.push(`ask workflow-secrets: confirm the repository's workflows see no CI secret on a branch an issue's session pushes, since they run that branch's own code; else ${SECRETS_ACCEPTED}`);
    return;
  }
  let read;
  try {
    read = facade.workflowSecrets(named, reads);
  } catch (error) {
    failed('workflow-secrets', `the forge cannot say which CI secrets the repository's workflows see (${String(error.message).split('\n')[0]})${permissions}; ${SECRETS_ACCEPTED}`);
    return;
  }
  let token = 'and the signed-in token names no scopes, so it may push a change to a workflow file too';
  if (read.workflowPush === true) token = 'and the signed-in token\'s scopes include workflow, so it may push a change to a workflow file too';
  if (read.workflowPush === false) token = 'though the signed-in token cannot push a change to a workflow file, which narrows it only';
  check('workflow-secrets', read.secrets > 0 ? `the repository's workflows see ${read.secrets} CI secrets, and the forge runs its push and pull request workflows on an issue's branch with the branch's own code, its tests, scripts, and build, which the session writes, so a change to them could read the secrets, ${token}; move the secrets to environments held for a reviewer who is not the signed-in user, when the signed-in user is not an admin of the repository (an admin's token can edit the rule), since a deployment branch rule is no hold against code the run pushes; ${SECRETS_ACCEPTED}` : null);
}

// Why a start may not launch an issue's session, by what the forge holds it to (holdLines), read with `token`, the one
// the start hands the session, or with the forge CLI's own login on a host that hands none: { halt } when a rule or a
// secret does not hold, or the forge cannot say, which no person answers at a start, whatever else failed; else { retry }
// when a read failed, which may pass later; or null. Each line is the preflight's own reason.
export function holdsProblem({ facade, repository, policy, token = null }) {
  const problems = [];
  const unread = [];
  const asks = [];
  holdLines({
    facade, repository, policy, token, lines: [], asks, notes: false,
    check: (name, problem) => problem && problems.push(`${name}: ${problem}`),
    failed: (name, why) => unread.push(`${name}: ${why}`),
  });
  // A blocker the forge confirmed halts whatever else it could not answer, so a read that keeps failing never hides it.
  const open = [...problems, ...asks.map((line) => line.replace(/^ask /u, ''))];
  if (open.length) return { halt: `the forge does not hold the issue sessions as a run needs, and a start has no person to answer it: ${open.join('; ')}` };
  return unread.length ? { retry: [...new Set(unread)].join('; ') } : null;
}
