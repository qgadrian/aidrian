#!/bin/sh
# The persona-audit-pr-url case's scaffold: the synthetic bike shop, its four personas, and a member's pull request 5,
# whose diff touches three of them, in a run folder whose state folder is .eval-state. On top of it: this skill is
# removed from the copy, as persona-audit is, so the baseline arm cannot read it; the shop gains a product doc tagged
# product_sensitive for the product-manager read; and the gh in .eval-bin also answers what `aidrian pr product-feedback`
# reads and writes, with no network: a post or an edit lands in .eval-bin/posted.json, never on GitHub. The copy's
# repository is on github.invalid, a host no one can register, so a run that misses .eval-bin and reaches a real gh gets
# a failure to reach the host, never a real pull request.
set -eu
sh "$(dirname "$0")/../persona-audit-pr-url/scaffold.sh"
git remote set-url origin https://github.invalid/acme/bike-shop.git
git rm -r -q --cached --ignore-unmatch plugins/aidrian/skills/pr-product-feedback
rm -rf plugins/aidrian/skills/pr-product-feedback
cat > bike-shop/rules.md <<'DOC'
# Shop rules

## Repairs

- A repair is booked only for a day the mechanic works.
- A closed repair leaves the open list at once.

## Counter copy

- Counter screens use the words the front desk says to customers, and name the day in full.
DOC
node -e '
const fs = require("node:fs");
const index = ".aidrian/knowledge/20-bike-shop.json";
const bucket = JSON.parse(fs.readFileSync(index, "utf8"));
bucket.docs["rules.md"] = { summary: "The bike shop product rules: repairs and counter copy.", tags: ["product_sensitive"] };
fs.writeFileSync(index, JSON.stringify(bucket, null, 2) + "\n");
const view = ".eval-bin/view.json";
const files = ["src/check-in.js", "src/repairs.js", "src/parts.js"].map((path) => ({ path, changeType: "MODIFIED" }));
const pr = { ...JSON.parse(fs.readFileSync(view, "utf8")), url: "https://github.invalid/acme/bike-shop/pull/5", author: { login: "shop-dev" }, files, changedFiles: files.length, reviewDecision: "", latestReviews: [] };
fs.writeFileSync(view, JSON.stringify(pr) + "\n");
'
cat > .eval-bin/gh <<'GH'
#!/usr/bin/env node
// The reads of one pull request on github.invalid, and the comment writes of `aidrian pr product-feedback post`, with no
// network. Anything else fails, another host or repository included, so a run cannot check anything out, and a comment
// lands in posted.json beside this file.
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
const args = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const fail = (line = 'gh: this fixture only reads pull request 5') => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};
const posted = path.join(here, 'posted.json');
const comment = () => (fs.existsSync(posted) ? JSON.parse(fs.readFileSync(posted, 'utf8')) : null);
const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null;
if (repo !== null && repo !== 'github.invalid/acme/bike-shop') fail();
else if (args[0] === 'pr' && args[1] === 'view') out(read('view.json'));
else if (args[0] === 'pr' && args[1] === 'diff') out(read('diff.txt'));
else if (args[0] === 'api' && args[1] === '--hostname' && args[2] === 'github.invalid') {
  const route = args[3] ?? '';
  const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
  const body = (args.find((each) => each.startsWith('body=')) ?? '').slice('body='.length);
  const comments = 'repos/acme/bike-shop/issues/5/comments';
  if (route === 'user') out({ login: 'eval-bot' });
  else if (route === 'repos/acme/bike-shop/pulls/5') out(read('pull.json'));
  else if (route === comments && method === 'GET') out([comment() ? [comment()] : []]);
  else if (route === comments && method === 'POST') {
    const written = { id: 1, user: { login: 'eval-bot' }, body };
    fs.writeFileSync(posted, JSON.stringify(written));
    out(written);
  } else if (route === 'repos/acme/bike-shop/issues/comments/1') {
    const found = comment();
    if (!found) fail('gh: Not Found (HTTP 404)');
    if (method === 'PATCH') {
      found.body = body;
      fs.writeFileSync(posted, JSON.stringify(found));
    }
    out(found);
  } else fail();
} else fail();
GH
chmod +x .eval-bin/gh
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q --amend -m fixture
