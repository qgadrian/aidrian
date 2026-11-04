#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it. Points the project's state folder at .eval-state in the run folder, so no audit outside the run is
# read or written, and copies the synthetic bike-shop reports there: a walk that replaces a read-only run, both
# written before sidecars, with small images the Read tool opens for the screenshots the walk cites. It gives the project a knowledge
# bucket: the product-access doc the walk cites, and an issue tracker kept as files, so a search needs no network.
# Arguments: `sidecar` also imports the walk, as the Human would have approved, so the run starts at the questions;
# `no-tracker` leaves the tracker doc out, so the project names none.
set -eu
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/skills/persona-audit-triage' ':(exclude)plugins/aidrian/evals' | tar -x -f -
node -e '
const fs = require("node:fs");
const file = ".aidrian/config.json";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.state = { ...config.state, dir: ".eval-state" };
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
'
case " $* " in *" no-tracker "*) tracker=no ;; *) tracker=yes ;; esac
mkdir -p bike-shop
cat > bike-shop/product-access.md <<'DOC'
# Product access

## Environments

- Local: `http://localhost:3000`, signed in as a staff member.

## Open questions

- May the front desk book a time that has already passed? Not decided yet.
DOC
if [ "$tracker" = yes ]; then
  mkdir -p tracker
  cat > bike-shop/tracker.md <<'DOC'
# Issue tracker

Issues are Markdown files in `tracker/`, one per issue, named `<number>-<slug>.md`; the number is the issue's key. A
`Labels:` line lists its labels, and any label may be used. Search with `grep -ril <words> tracker/`. Create an issue
by adding a file.
DOC
  cat > tracker/1-repaint-the-waiting-area.md <<'DOC'
# Repaint the waiting area

Labels: chore

Status: open.
DOC
fi
node -e '
const fs = require("node:fs");
const tracker = process.argv[1] === "yes" ? { "tracker.md": { summary: "The issue tracker: files in tracker/, how to search and create them.", tags: ["issue_tracker"] } } : {};
fs.writeFileSync(".aidrian/knowledge/20-bike-shop.json", JSON.stringify({
  dir: "bike-shop",
  description: "The bike shop product this run audits.",
  always: [],
  docs: { "product-access.md": { summary: "How a session reaches the product, and its open product questions.", tags: ["personas"] }, ...tracker },
}, null, 2) + "\n");
' "$tracker"
git init -q
echo .eval-state/ >> .git/info/exclude
XDG_STATE_HOME="$(pwd)/.eval-state/root"
export XDG_STATE_HOME
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
audits=.eval-state/audits
mkdir -p "$audits/front-desk-2026-05-02-2"
cp test/fixtures/persona-audit/front-desk-2026-05-02.md test/fixtures/persona-audit/front-desk-2026-05-02-2.md "$audits/"
# Every screenshot the walk cites, by full path or by suffix: a 64 by 48 sketch of a screen, as a baseline JPEG and a
# PNG, which the Read tool and the API both take; a smaller image with no Huffman tables was rejected by the API.
node -e '
const fs = require("node:fs");
const folder = process.argv[1];
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAwAEADASIAAhEBAxEB/8QAGgAAAgMBAQAAAAAAAAAAAAAAAAUDBAYHAv/EADAQAAAEBAIIBgIDAAAAAAAAAAABAgMEERXRBVMSFjFUVZGTowZBYWSi4SEiExRR/8QAFwEBAQEBAAAAAAAAAAAAAAAAAQACA//EABkRAQEAAwEAAAAAAAAAAAAAAAABAhEhEv/aAAwDAQACEQMRAD8A30ZFMQUMuJil6DSJaSpGcpnLYXqYWa1YJvvaXYSeKGXX/D0U0w2txxWhJKEmZn+5eRDntJxPh0Z0FWHXHGWdYtsb7WrBN97S7A1qwTfe0uwwNJxPh0Z0FWBScT4dGdBVhrxiPVb7WrBN97S7A1qwTfe0uwwNJxPh0Z0FWBScT4dGdBVheMV6rfa1YJvvaXYM4OKYjYZETCr02lz0VSMpyOWw/Uhy6k4nw6M6CrDoXhdl1jw9CtPtrbcTpzStJkZfufkYzljJOGW1fi3/AOtDLe0dLRl+Jyn+ZBbXfbdz6DGOYVEwa2UGRKVKRns2kYUUSKzGeZ2GZo1NXfbdz6BXfbdz6ENEisxnmdgUSKzGeZ2DxdTV323c+g1Zc/lYbclLTSSpf5MgkokVmM8zsHUOg2odptUpoQSTl6EC6USAAABVsRdWxAuONK0VplI5T8yCOqxuf8E2GhiWExLCmVmZJVKZlt2zFGiQuY9zKwZoUsqsbn/BNgVWNz/gmwZ0SFzHuZWBRIXMe5lYO4ullVjc/wCCbAqsbn/BNgzokLmPcysCiQuY9zKwtxdXoZanIVpazmpSCMz9ZCQeWkE00htM5ISSSn6D0Ml//9k=", "base64");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAeElEQVR42u3WoQ2AMBAF0JawGr4KzRwMwBxoVD0rIRAMgCXBEqDwvqzpvdyJH5d1CyWnCoUHAODvgPr8lLr+tePmcXBCAAAAAACHRHUaAOBzbXTK8z1/t6mxAQAAAAAAbdQJAWijD7XRS1qqEwIAAADQRm0AAKDg7DjIFKM68IJHAAAAAElFTkSuQmCC", "base64");
for (const n of [10, 13, 15, 20, 23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 38]) fs.writeFileSync(`${folder}/shot-17000000000${n}-${n}.jpg`, jpeg);
fs.writeFileSync(`${folder}/shot-1700000000022-22.png`, png);
' "$audits/front-desk-2026-05-02-2"
case " $* " in *" sidecar "*) sidecar=yes ;; *) sidecar=no ;; esac
if [ "$sidecar" = yes ]; then
  plugins/aidrian/bin/aidrian audits import front-desk-2026-05-02-2.md --not-rechecked F2,F3 --carried-forward F1 --write >/dev/null
  test -f "$audits/front-desk-2026-05-02-2.json"
fi
plugins/aidrian/bin/aidrian audits list --json >/dev/null
