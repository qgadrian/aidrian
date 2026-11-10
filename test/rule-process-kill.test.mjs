import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { firstSentence } from '../plugins/aidrian/lib/hook-deny.mjs';
import { check as grepChainCheck } from '../plugins/aidrian/lib/rules/grep-exit-chain.mjs';
import { check } from '../plugins/aidrian/lib/rules/process-kill.mjs';

const decideForCommand = (command, env) => {
  const reason = check(command, { env });
  return reason ? { decision: 'deny', reason } : { decision: 'allow' };
};

// Ported from the source harness. The kill rule alone: the listing rule's override is set so a kill-rule row
// cannot pass or fail on the listing rule. The listing rule has its own tables
// below, judged with no override at all.
const ENV = { AIDRIAN_ALLOW_PROCESS_ARGS_LISTING: '1' };

const deny = (command) =>
  assert.equal(decideForCommand(command, ENV).decision, 'deny', `expected deny: ${command}`);
const allow = (command) =>
  assert.equal(decideForCommand(command, ENV).decision, 'allow', `expected allow: ${command}`);

test('denies pkill and killall in every spelling', () => {
  deny('pkill -f eslint');
  deny('pkill eslint');
  deny('pkill -9 -f run-lint-lanes');
  deny('killall node');
  deny('killall -9 next-build');
  deny('sudo pkill -f tsgolint');
  deny('/usr/bin/pkill -f eslint');
  deny('rtk pkill -f eslint');
  deny('rtk proxy killall node');
});

test('denies a by-name kill behind signal spellings, prefixes, xargs and inline shells', () => {
  deny('pkill -PIPE -f eslint');
  deny('pkill -PROF eslint');
  deny('timeout 5 pkill -f eslint');
  deny('timeout -s KILL 5 pkill -f eslint');
  deny('env pkill -f eslint');
  deny('env FOO=1 nice -n 5 pkill -f eslint');
  deny('env -u CI pkill -f eslint');
  deny('env --unset=CI -i pkill -f eslint');
  deny('sudo -u root pkill -f eslint');
  deny('sudo -u root -g wheel -- killall node');
  deny('sudo -R / pkill -f eslint');
  deny('sudo --chroot / killall node');
  deny('sudo --chroot=/ pkill -f eslint');
  deny('sudo --chdir=/tmp/ pkill -f eslint');
  deny('builtin kill -- -1');
  deny('builtin kill $(pgrep -f eslint)');
  deny('case x in x) pkill -f eslint;; esac');
  deny('case x in (x) pkill -f eslint;; esac');
  deny('case $1 in\n  a) echo hi;;\n  b|c) pkill -f x ;;\nesac');
  deny('case x in *) sudo pkill -f eslint;; esac');
  deny('command -v pkill && pkill -f eslint');
  deny('sudo -n -u root env -u CI timeout -k 2 5 pkill -f eslint');
  deny('exec -a lint pkill -f eslint');
  deny('env --default-signal pkill -f eslint');
  deny('env --ignore-signal=INT --block-signal pkill -f eslint');
  deny('echo eslint | xargs --max-args 1 pkill -f');
  deny('echo node | xargs --max-procs 2 --delimiter , killall');
  deny('pgrep -f eslint | xargs --max-args=1 --replace kill');
  deny('! pkill -f eslint');
  deny('(pkill -f eslint)');
  deny('( pkill -f eslint )');
  deny('{ pkill -f eslint; }');
  deny('if true; then pkill -f eslint; fi');
  deny('while true; do pkill -f eslint; done');
  deny('time pkill -f eslint');
  deny('time -p pkill -f eslint');
  deny('time -p -- pkill -f eslint');
  deny('(kill -- -1)');
  deny('(sudo -u root pkill -f eslint)');
  deny('env -S "pkill -f eslint"');
  deny('env --split-string="pkill -f eslint"');
  deny("env -S'pkill -f eslint'");
  deny('env -i -S"pkill -f eslint"');
  deny('sudo FOO=1 pkill -f eslint');
  deny('sudo -n FOO=1 killall node');
  deny('echo eslint | xargs env FOO=1 pkill -f');
  deny('echo eslint | xargs sh -c "pkill -f eslint"');
  deny('echo eslint | xargs -n1 timeout 5 pkill -f');
  deny('eval "pkill -f eslint"');
  deny('eval pkill -f eslint');
  deny('pgrep -f eslint | xargs sudo kill -9');
  deny('command pkill -f eslint');
  deny('exec killall node');
  deny('nohup pkill -f eslint &');
  deny('echo eslint | xargs pkill -f');
  deny('echo node | xargs -n1 killall');
  deny('bash -c "pkill -f eslint"');
  deny("sh -c 'kill $(pgrep -f eslint)'");
  // `--` ends the shell's options; the string after it is still the script
  deny("bash -c -- 'pkill -f eslint'");
  deny("sh -c -- 'killall node'");
  deny("bash -c -x 'pkill -f eslint'");
  deny("bash -c -o pipefail -- 'pkill -f eslint'");
  deny("pgrep -f eslint | xargs sh -c -- 'kill $0'");
  deny("pgrep -f eslint | xargs sh -c 'kill $0'");
  deny("PIDS=$(pgrep -f eslint); sh -c 'kill $PIDS'");
  // the listing itself may run inside an inline shell or eval within the substitution
  deny("kill $(sh -c 'pgrep -f eslint')");
  deny("kill $(bash -c -- 'pgrep -f eslint')");
  deny('kill $(eval pgrep -f eslint)');
  // procps-ng pgrep --signal is pkill by another name
  deny('pgrep --signal KILL -f eslint');
  deny('pgrep --signal=TERM eslint');
  deny('sudo pgrep --signal 9 -f node');
  deny('pgrep --si KILL -f eslint');
  deny('pgrep --sig=TERM eslint');
  allow('pgrep --session 1 eslint');
  // sudo options whose attached value carries a slash (sudo is read in place, not re-guessed after a basename)
  deny('sudo --chdir=/tmp pkill -f eslint');
  deny('sudo --chroot=/tmp killall node');
  deny('sudo -D /tmp pkill -f eslint');
  deny('/usr/bin/sudo pkill -f eslint');
  deny('FOO=1 sudo -u root pkill -f eslint');
  deny('sudo --chdir=/tmp -- kill $(pgrep -f eslint)');
  // ps still counts as a listing when it selects by name
  deny('ps -C eslint -o pid= | xargs kill');
  deny('kill $(ps -p 1 -C eslint -o pid=)');
  // a pid selector beside a widening one is still every process
  deny('ps -p $$ -A -o pid= | xargs kill');
  deny('kill $(ps -p $$ -A -o pid=)');
  deny('kill $(ps -p 1234 -e -o pid=)');
  deny('kill $(ps -p 1234 aux)');
  deny('kill $(ps -p 1234 --deselect -o pid=)');
  // the env -S string is env's own argv, options and all
  deny("env -S '-i pkill -f eslint'");
  deny("env -S '-- pkill -f eslint'");
  deny("env --split-string='-u CI pkill -f eslint'");
  deny("env -S'FOO=1 pkill -f eslint'");
  deny('bash -lc "cd /x && pkill -f eslint"');
});

test('denies the pgid -1 broadcast and a parent scope of pid 1', () => {
  deny('kill -- -1');
  deny('kill -9 -1');
  deny('kill -s TERM -1');
  deny('kill -- -01');
  deny('kill -9 -- -001');
  deny('pkill -P 1 -f eslint');
  deny('pkill -P 01 -f node');
  deny('pkill -P +1 -f node');
  deny('pkill -P01 eslint');
  deny('pkill --parent=+01 eslint');
  deny('pkill -P 1234,01 eslint');
  deny('pkill -P abc eslint');
  deny('pkill -P1 eslint');
  deny('pkill --parent=1 eslint');
  deny('pkill -P 0,1 eslint');
  deny('P=1; pkill -P "$P" eslint');
  deny('pkill -P $PPID eslint');
  deny('pkill --parent "${TARGET}" -f node');
  // pkill unions its -P selectors: one bad one widens the scope to every orphan
  deny('pkill -P 1234 -P 1 -f eslint');
  deny('pkill --parent=1234 -P 1 -f eslint');
  deny('pkill -P $$ -P 1 -f eslint');
  deny('pkill -P 1234 --parent "$P" -f eslint');
});

test('denies a by-name kill in a later segment of a compound command', () => {
  deny('cd /tmp/x && pkill -f eslint');
  deny('echo relieving memory; killall node');
});

test('denies kill fed by pgrep or ps, however the pids travel', () => {
  deny('kill $(pgrep -f eslint)');
  deny('kill -9 $(pgrep -f "run-agent-gates")');
  deny('kill -9 `pgrep -f eslint`');
  deny('pgrep -f eslint | xargs kill');
  deny('pgrep -f eslint | xargs -n1 kill -9');
  deny('pgrep -f eslint | xargs -I {} kill -TERM {}');
  deny("ps aux | grep eslint | grep -v grep | awk '{print $2}' | xargs kill -9");
  deny('PIDS=$(pgrep -f eslint); kill $PIDS');
  deny('kill -9 $(/usr/bin/pgrep -f eslint)');
  deny('kill $(sudo pgrep -f eslint)');
  deny('kill $(rtk pgrep -f eslint)');
  deny('kill $(rtk proxy pgrep -f eslint)');
  // the listing may sit behind a prefix's options or assignments inside the substitution
  deny('kill $(env FOO=1 pgrep -f eslint)');
  deny('kill $(env -i pgrep -f eslint)');
  deny('kill $(env -u CI pgrep -f eslint)');
  deny('kill $(sudo -u root pgrep -f eslint)');
  deny('kill $(nice pgrep -f eslint)');
  deny('kill $(timeout 5 pgrep -f eslint)');
  deny('kill $(command pgrep -f eslint)');
  deny('kill $(env -S "pgrep -f eslint")');
  deny('kill $(pgrep -f $(echo eslint))');
  deny('kill `env FOO=1 pgrep -f eslint`');
  deny('kill $(pidof node)');
  deny('pidof node | xargs kill');
});

test('allows signal-0 liveness probes fed by a listing, and nothing that only resembles one', () => {
  allow('pid=$(pgrep -f "next dev"); while kill -0 "$pid" 2>/dev/null; do sleep 5; done');
  allow('kill -s 0 $(pgrep -f x)');
  allow('kill -n 0 $(pgrep -f x)');
  allow('pgrep -f x | xargs kill -0');
  // a probe beside a real kill, or a signal that only starts with 0, is still the sweep
  deny('kill -0 $(pgrep -f x) && kill $(pgrep -f x)');
  deny('kill -09 $(pgrep -f x)');
  deny('kill -00 $(pgrep -f x)');
  deny('kill -s 9 $(pgrep -f x)');
  deny('kill "$SIG" $(pgrep -f x)');
  deny('kill -s "$SIG" $(pgrep -f x)');
  deny('pgrep -f x | xargs kill');
  deny('pgrep -f x | xargs kill -9');
});

test('denies a probe whose later signal option replaces the 0, and keeps a later -9 a probe', () => {
  // bash's builtin kill (and procps kill) let a later -s / -n win: these send SIGKILL
  deny('kill -0 -s 9 $(pgrep -f x)');
  deny('kill -0 -s"$SIG" $(pgrep -f x)');
  deny('kill -s 0 -s 9 $(pgrep -f x)');
  deny('kill -0 -n 9 $(pgrep -f x)');
  deny('kill -0 --signal=KILL $(pgrep -f x)');
  deny('kill -0 --signal KILL $(pgrep -f x)');
  deny('pgrep -f x | xargs kill -0 -s 9');
  deny("bash -c 'kill -0 -s 9 $(pgrep -f x)'");
  deny('PIDS=$(pgrep -f eslint); kill -0 -s 9 $PIDS');
  // the broadcast to every process the user owns, no longer a probe
  deny('kill -0 -s 9 -1');
  deny('kill -0 -s 9 -- -1');
  // attached forms (bash 4+ -sKILL / -n9, getopt -s9), a getopt long-option abbreviation, an option after the pids
  deny('kill -0 -sKILL $(pgrep -f x)');
  deny('kill -0 -s9 $(pgrep -f x)');
  deny('kill -0 -n9 $(pgrep -f x)');
  deny('kill -0 --sig=KILL $(pgrep -f x)');
  deny('kill -0 $(pgrep -f x) -s 9');
  // -9 after the signal is pgid 9 under signal 0, still a probe
  allow('kill -0 -9 $(pgrep -f x)');
  allow('kill -s 0 -9 $(pgrep -f x)');
  allow('kill -0 -- $(pgrep -f x)');
});

test('allows stopping processes the caller owns', () => {
  allow('kill 1234');
  allow('kill -9 1234');
  allow('kill -TERM 1234 5678');
  allow('kill -- -1234');
  allow('kill -9 -- -1234');
  allow('kill -- -01234');
  allow('kill %1');
  allow('kill -1 1234');
  allow('kill -HUP 1234');
  allow('kill $PID');
  allow('kill $(cat .dev-server.pid)');
  allow('cat pids.txt | xargs kill');
});

test('allows pkill scoped to one parent process', () => {
  allow('pkill -P 1234');
  allow('pkill -P $$ -f node');
  allow('pkill --parent 1234');
  allow('pkill -P1234');
  allow('pkill --parent=1234 -f node');
  allow('pkill -P 01234 -f node');
  allow('pkill -P +1234 -f node');
  allow('timeout 5 pkill -P 1234');
  allow('pkill -P "$$" node');
  allow('pkill -P $BASHPID -f node');
  allow('(pkill -P 1234)');
  allow('pkill -P 1234 -P 5678 -f node');
  allow('pkill -P $$ --parent=1234 -f node');
});

test('allows listing by name without killing, and literal pids beside a listing', () => {
  allow('pgrep -f eslint');
  allow('ps aux | grep eslint');
  allow('pgrep -f eslint; kill 1234');
  allow('pgrep --signal KILL -P $$ -f node');
  allow("sh -c 'pgrep -f eslint'");
  // inspecting a pid you already hold is the sanctioned workflow, not a listing by name
  allow('ps -p "$PID"; kill "$PID"');
  allow('ps -p 1234 -o rss=; kill 1234');
  allow('ps --pid $PID && kill -TERM $PID');
  allow('ps -q 1234 -o stat= ; kill -- -1234');
  allow('ps -p "$PID" -o pid=,rss= --no-headers; kill "$PID"');
  allow('ps -fp 1234; kill 1234');
  allow("echo '$(pgrep -f eslint)'; kill $PID");
});

test('allows the words inside quoted text, heredocs and non-kill programs', () => {
  allow('echo pkill -f eslint');
  allow('git commit -m "ban pkill -f by name"');
  allow('cat <<EOF > /tmp/notes\npkill -f eslint\nEOF');
  allow('man pkill');
  allow('command -v pkill');
  allow('command -V killall');
  allow('command -pv pkill');
  allow('command -p -v pkill');
  allow('command -v pkill && kill 1234');
  allow('case x in x) echo hi;; esac');
  allow('case $1 in\n  a) kill 1234;;\nesac');
  allow('grep -rn pkill scripts/');
  allow('bash -c "echo pkill"');
  allow('sh -c "kill 1234"');
  allow('env -S "printf %s hi"');
  allow('echo 1234 | xargs kill');
  allow('eval "$CMD"');
});

test('a listing that a comment, single quotes or a quoted heredoc only mentions lists nothing', () => {
  allow('kill $PID # not $(pgrep -f eslint)');
  allow("cat <<'EOF' > /tmp/notes\nkill $(pgrep -f eslint)\nEOF\nkill \"$PID\"");
  allow("echo 'was: kill `pgrep -f eslint`'; kill $PID");
  // one that runs still feeds a dynamic kill: an unquoted heredoc, double quotes, a nested shell
  deny('cat <<EOF > /tmp/pids\n$(pgrep -f eslint)\nEOF\nkill $(cat /tmp/pids)');
  deny('kill "$(pgrep -f eslint)"');
  deny('kill "`pgrep -f eslint`"');
  deny("sh -c 'kill $(pgrep -f eslint)' # by name");
});

test('reads a process substitution and the lines after a here-string', () => {
  // `<(…)` runs its body, so a listing there feeds a dynamic kill like `$(…)` does
  deny('while read -r p; do kill "$p"; done < <(pgrep -f eslint)');
  deny('kill $(cat <(pgrep -f eslint))');
  deny('xargs kill < <(pgrep -f eslint)');
  allow('kill $(cat <(echo 1234))');
  // a here-string is one input redirect, not a heredoc: the lines after it are commands
  deny('cat <<<"x"\npkill -f eslint');
  deny('read -r x <<<"$v"\nkill $(pgrep -f eslint)');
  allow('cat <<<"x"\nkill 1234');
});

test('denies a by-name kill inside a substitution that runs, and none in one that does not', () => {
  deny('result=$(pkill -f node)');
  deny('echo `killall node`');
  deny('cat <(pkill -f node)');
  deny('cat <<EOF\n$(pkill -f node)\nEOF');
  deny('echo "$(pkill -f node)"');
  deny('x=$(echo $(pkill -f node))');
  deny("x=$(sh -c 'pkill -f node')");
  // a listing anywhere on the line feeds a dynamic kill in a substitution
  deny('x=$(kill $(pgrep -f node))');
  deny('PIDS=$(pgrep -f node); echo $(kill $PIDS)');
  allow('x=$(kill 1234)');
  allow('x=$(pkill -P $$ node)');
  allow("cat <<'EOF'\n$(pkill -f node)\nEOF");
  allow("echo '$(pkill -f node)'");
  allow('echo done # $(pkill -f node)');
  allow("git commit -m \"$(cat <<'EOF'\nfix: a) the first\nnever `pkill -f node`\nEOF\n)\"");
});

test('allows unclassifiable dynamic invocations (fail-open)', () => {
  allow('$KILLER -f eslint');
  allow('rtk $CMD -f eslint');
  allow('pgrep -f eslint | xargs $KILL');
});

test('allows empty and non-string commands', () => {
  allow('');
});

test('honors the human override env var', () => {
  assert.equal(
    decideForCommand('pkill -f eslint', { AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME: '1' }).decision,
    'allow',
  );
});

test('deny reason names the owned alternatives and the override', () => {
  const { reason } = decideForCommand('pkill -f eslint', ENV);
  assert.match(reason, /kill <pid>/u);
  assert.match(reason, /kill -- -<pgid>/u);
  assert.match(reason, /AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME=1/u);
});

const NO_OVERRIDE = {};
const LISTING_REASON = /prints full command lines/u;

const denyListing = (command) => {
  const { decision, reason } = decideForCommand(command, NO_OVERRIDE);
  assert.equal(decision, 'deny', `expected deny: ${command}`);
  assert.match(reason, LISTING_REASON, `expected the listing reason: ${command}`);
};
const allowListing = (command) =>
  assert.equal(decideForCommand(command, NO_OVERRIDE).decision, 'allow', `expected allow: ${command}`);

test('denies pgrep when it prints full argument lists', () => {
  denyListing('pgrep -fl next');
  denyListing('pgrep -lf next');
  denyListing('pgrep -fla next');
  denyListing('pgrep -f -l next');
  denyListing('pgrep -l next -f');
  denyListing('pgrep --full --list-name next');
  denyListing('pgrep -a next');
  denyListing('pgrep -xa next');
  denyListing('pgrep --list-full next');
  denyListing('pgrep --list-f next');
});

test('denies ps unless an explicit format names no argument column', () => {
  denyListing('ps');
  denyListing('ps aux');
  denyListing('ps -ef');
  denyListing('ps -f');
  denyListing('ps e');
  denyListing('ps -E');
  denyListing('ps eww');
  denyListing('ps u');
  denyListing('ps -o args=');
  denyListing('ps -o pid=,command=');
  denyListing('ps -o "pid= cmd"');
  denyListing('ps --format=pid,args');
  denyListing('ps -O pid');
  denyListing('ps -p 123');
  denyListing('ps -o "$FMT"');
  denyListing('ps -o');
  // these add a command column to an -o list on macOS
  denyListing('ps -o pid= -j');
  denyListing('ps -o pid= -v');
  denyListing('ps -o pid= -l');
  denyListing('ps -eo pid= -F');
  // a procps AIX descriptor is not read: %a is args; only %cpu and %mem are keywords
  denyListing('ps -o "%p %a"');
  denyListing('ps -eo pid,%cpu,%a');
  denyListing('ps -o %cpu%a');
  // a bare word or a dynamic operand may be a BSD cluster
  denyListing('ps -o pid=,comm= aux');
  denyListing('ps -o pid=,comm= $X');
  denyListing('ps --forest -o pid=');
});

test('denies an argument column at any format width', () => {
  // procps reads `key:width`: `args:200` is still the full command line
  denyListing('ps -o args:200');
  denyListing('ps -eo pid,args:200');
  denyListing('ps -oargs:200');
  denyListing('ps -o cmd:200=');
  denyListing('ps -o pid=,command:80=CMD');
  denyListing('ps --format args:200');
  denyListing('ps --format=pid,cmd:50');
  denyListing('ps -p 1 -o "pid comm args:9"');
  allowListing('ps -o pid:8,comm:20');
  allowListing('ps -eo pid=,comm:32=');
  allowListing('ps --format=pid:6,%cpu:5,comm:20 -e');
});

test('judges a nested listing like a top-level one', () => {
  denyListing("sh -c 'pgrep -fl next'");
  denyListing('bash -c -- "pgrep -a next"');
  denyListing('echo $(ps aux)');
  denyListing('x=`ps -ef`');
  denyListing('eval ps aux');
  denyListing('env -S "ps aux"');
  denyListing('echo 1 | xargs ps');
  denyListing('timeout 5 ps aux');
  denyListing('sudo ps aux');
  denyListing('rtk ps aux');
  denyListing('cd /tmp && ps aux | grep next');
});

test('judges a nested string that expands by its literal text', () => {
  // the escaped `$` makes the token dynamic, yet the `ps` / `pkill` it spells out runs
  denyListing('bash -c "echo \\$HOME; ps aux"');
  denyListing('eval "echo \\$HOME; ps aux"');
  deny('sh -c "kill \\$(pgrep -f x)"');
  deny('bash -c "echo \\$HOME; pkill -f x"');
  deny('eval "echo \\$HOME; pkill -f x"');
  allowListing('bash -c "ps -o pid=,comm= -p $PID"');
  allow('bash -c "kill $PID"');
  allow('bash -c "$CMD"');
});

test('allows listings that print pids and names only', () => {
  allowListing('ps -o pid=,ppid=,pcpu=,rss=,etime=,comm=');
  allowListing('ps -e -o pid=,comm=');
  allowListing('ps -A -o pid=,comm=');
  allowListing('ps -eo pid=,comm=');
  allowListing('ps -p 123 -o comm=');
  allowListing('ps -o comm= -p "$PID"');
  allowListing('ps -o pid=,rss= --pid=1 --no-headers');
  allowListing('ps --format pid,comm -e');
  allowListing('ps -eo pid,%cpu,%mem,comm');
  allowListing('ps -p 1234 -o pid,ppid,%cpu,%mem,rss,etime,comm');
  allowListing('ps -o %cpu=,%mem= -p 1');
  allowListing('pgrep next');
  allowListing('pgrep -f next');
  allowListing('pgrep -f "$NAME"');
  allowListing('pgrep -l next');
  allowListing('pgrep -P 123');
  allowListing('pgrep -F/tmp/lf.pid');
  allowListing('rtk ps -o pid=,comm=');
  allowListing('pidof node');
});

test('allows the listing words inside quoted text, heredocs and other programs', () => {
  allowListing('grep aux file');
  allowListing('echo ps aux');
  allowListing("echo '$(ps aux)'");
  allowListing('git commit -m "deny ps aux"');
  allowListing('cat <<EOF > /tmp/notes\nps aux\nEOF');
});

test('reads a substitution only where the shell runs it', () => {
  // text: a quoted heredoc, single quotes, a comment
  allowListing("cat <<'EOF'\n$(ps aux)\nEOF");
  allowListing('cat <<"EOF" > /tmp/notes\nx=`ps -ef`\nEOF');
  allowListing('cat <<\\EOF\n$(ps aux)\nEOF');
  allowListing("cat <<-'EOF'\n\t$(ps aux)\n\tEOF");
  allowListing("git commit -m \"$(cat <<'EOF'\nfix: deny $(ps aux) and `ps -ef`\nEOF\n)\"");
  allowListing("echo 'pids: `ps -ef`'");
  allowListing('echo safe # $(ps aux)');
  allowListing('echo safe #`ps -ef`');
  allowListing("grep next <<< '$(ps -ef)'");
  allowListing("grep next <<<'$(ps -ef)'");
  allowListing('cat <(echo hi)');
  // run: an unquoted heredoc, double quotes, backticks, a nested shell, a here-string
  denyListing('cat <<EOF\n$(ps aux)\nEOF');
  denyListing("cat <<EOF\nit's $(ps aux)\nEOF");
  denyListing('cat <<-EOF\n\t`ps -ef`\n\tEOF');
  denyListing('x=$(cat <<EOF\n$(ps aux)\nEOF\n)');
  denyListing('echo "$(ps aux)"');
  denyListing('echo "pids: `ps -ef`"');
  denyListing('echo "$(echo "x") $(ps aux)"');
  denyListing('x=`ps aux`');
  denyListing("sh -c 'echo $(ps aux)'");
  denyListing("bash -c 'cat <<EOF\n$(ps aux)\nEOF'");
  denyListing('echo a#$(ps aux)');
  denyListing('echo safe # a note\necho $(ps aux)');
  denyListing('grep next <<<"$(ps -ef)"');
  denyListing('grep next <<< "$(ps -ef)"');
  // a here-string is one input redirect; the lines after it are commands
  denyListing('grep next <<<"$names"\necho $(ps aux)');
  denyListing('grep next <<<"$names"\nps aux');
  // a process substitution runs its body
  denyListing('grep node <(ps aux)');
  denyListing('diff <(ps -ef) /dev/null');
  denyListing('tee >(ps aux) </dev/null');
});

test('both rules together still allow the owned-kill workflow', () => {
  allowListing('kill 1234');
  allowListing('kill -- -1234');
  allowListing('kill $(cat .dev-server.pid)');
  allowListing('ps -p 1234 -o rss=; kill 1234');
  allowListing('pkill -P 1234');
});

test('a by-name kill fed by a listing reports the kill reason first', () => {
  const { decision, reason } = decideForCommand("ps aux | grep eslint | awk '{print $2}' | xargs kill -9", NO_OVERRIDE);
  assert.equal(decision, 'deny');
  assert.match(reason, /AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME=1/u);
});

test('each override opens its own rule only', () => {
  const listingOpen = { AIDRIAN_ALLOW_PROCESS_ARGS_LISTING: '1' };
  const killOpen = { AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME: '1' };
  assert.equal(decideForCommand('ps aux', listingOpen).decision, 'allow');
  assert.equal(decideForCommand('pkill -f eslint', listingOpen).decision, 'deny');
  assert.equal(decideForCommand('pkill -f eslint', killOpen).decision, 'allow');
  assert.equal(decideForCommand('ps aux', killOpen).decision, 'deny');
  assert.match(decideForCommand('ps aux', killOpen).reason, LISTING_REASON);
});

test('listing deny reason names the root cause, the safe forms, and the override', () => {
  const { reason } = decideForCommand('pgrep -fl next', NO_OVERRIDE);
  assert.match(reason, /macOS/u);
  assert.match(reason, /sets its own title/u);
  assert.match(reason, /inherited environment as arguments/u);
  assert.ok(reason.includes('`ps -o pid=,ppid=,pcpu=,rss=,etime=,comm=`'));
  assert.ok(reason.includes('`pgrep <pattern>`'));
  assert.ok(reason.includes('`pgrep -f <pattern>`'));
  assert.ok(reason.includes('`pgrep -l <pattern>` without `-f`'));
  assert.match(reason, /AIDRIAN_ALLOW_PROCESS_ARGS_LISTING=1/u);
});

// The forms sessions reached for after a listing deny, from the dispatch log's hook_deny rows and their transcripts.
test('a listing whose output reaches only /dev/null or a counter runs', () => {
  allowListing('ps -p 58825 >/dev/null');
  allowListing('ps -p $p >/dev/null && echo alive');
  allowListing('ps aux >/dev/null 2>&1');
  allowListing('ps aux &>/dev/null');
  allowListing('ps aux 1>/dev/null');
  allowListing('ps aux | grep -c "[g]it push"');
  allowListing('ps aux | grep -q node && echo running');
  allowListing('ps -A | wc -l');
  allowListing('pgrep -l node | wc -l');
  allowListing('pgrep -lf eslint | head -3 >/dev/null');
  allowListing('ps aux | grep -E "next build|playwright" | grep -v grep | wc -l');
  allowListing('n=$(ps aux | grep -c node); echo "$n"');
});

test('a listing whose output can still be read stays denied', () => {
  denyListing('ps aux 2>/dev/null');
  denyListing('ps aux >/tmp/procs.txt');
  denyListing('ps aux >/dev/null 1>&2');
  denyListing('ps aux >/dev/null >/tmp/procs.txt');
  denyListing('ps aux | grep node');
  denyListing('ps aux | tee /tmp/procs.txt | wc -l');
  denyListing("ps aux | awk '{print}' | wc -l");
  denyListing('ps aux | sort >/tmp/procs.txt');
  denyListing('ps aux | wc -l; ps aux');
  denyListing('x=$(ps aux); echo "$x" | wc -l');
});

test('no listing passes for where its output goes through a nested shell, eval, env -S, or xargs', () => {
  denyListing("sh -c 'ps aux >&2' >/dev/null");
  denyListing("sh -c 'ps aux > /tmp/procs' | wc -l");
  denyListing("timeout 800 sh -c 'while ps -p 58825 >/dev/null; do sleep 5; done'");
  denyListing("eval 'ps aux >&2' >/dev/null");
  denyListing("env -S 'ps aux' >/dev/null");
  denyListing('echo 1 | xargs ps | wc -l');
});

test('a program between the listing and its counter passes it on only with no operand and no output option', () => {
  allowListing('ps aux | grep -v grep | head -n 5 | sort -rk 2 | uniq | cut -c1-80 | wc -l');
  allowListing('ps aux | grep -e node -i | tail -3 | wc -l');
  denyListing('ps aux | sort -o /dev/stderr | wc -l');
  denyListing('ps aux | sort -ro /dev/stderr | wc -l');
  denyListing('ps aux | sort --output=/dev/stderr | wc -l');
  denyListing('ps aux | uniq /dev/stdin /dev/stderr | wc -l');
  denyListing('ps aux | uniq - /dev/stderr | wc -l');
  denyListing('ps aux | head -n 5 /dev/stdin | wc -l');
  denyListing('ps aux | grep node /dev/stdin | wc -l');
  denyListing('ps aux | grep -e node /dev/stdin | wc -l');
  denyListing('ps aux | tr a-z A-Z | wc -l');
  denyListing('ps aux | cut -c1-80 "$F" | wc -l');
});

test('a word that may expand anywhere in a program between the listing and its counter, an option value included, fails it', () => {
  denyListing("OPTS='1 -o /dev/stderr'; ps aux | sort -k $OPTS | wc -l");
  denyListing('ps aux | uniq -f $OPTS | wc -l');
  denyListing('ps aux | head -n "$N" | wc -l');
  denyListing('ps aux | cut -c$W | wc -l');
  denyListing('ps aux | grep -e "$P" | wc -l');
  denyListing('ps aux | grep -m $M x | wc -l');
  denyListing('ps aux | grep x* | wc -l');
});

// The lexer reads a named descriptor after quotes are gone, so a quoted '{x}' word reads as one: no rule may open on it.
// A quoted '{x}' or '2' before a redirect is an argument, as bash passes it; an unquoted {x}> is a redirect and no argument.
test('a quoted word before a redirect is an argument, and a named descriptor takes no argument slot', () => {
  deny("ps -p 1 '{x}'>/tmp/f; kill $X");
  deny("ps -p 1 '2'>/tmp/f; kill $X");
  denyListing("ps -o pid= '{x}'>/tmp/f");
  denyListing("ps -o pid= '2'>/tmp/f");
  denyListing("ps aux | sort '{x}'>/tmp/f | wc -l");
  denyListing("ps aux | sort '2'>/dev/null | wc -l");
  allowListing("ps aux '{x}'>/dev/null");
  allowListing('ps -o pid= {x}>/dev/null');
  const { reason } = decideForCommand("pgrep -fl next '{x}'>/tmp/f", NO_OVERRIDE);
  assert.ok(!reason.includes('Run this instead'), 'a word ending in } gets no rewrite, as before');
});

test('a named descriptor before a command, or among a prefix\'s words, hides neither the command nor its kill', () => {
  deny('{fd}>/dev/null pkill node');
  deny('{fd}>/dev/null kill -- -1');
  deny('sudo {fd}>/dev/null pkill node');
  deny('FOO=1 {fd}>/dev/null pkill node');
  deny('env {fd}>/dev/null pkill node');
  deny('nohup {fd}>/dev/null pkill node');
  deny('pgrep -f x | xargs {fd}>/dev/null kill');
  deny('sudo -- {fd}>/dev/null pkill node');
  deny('sudo -u {fd}>/dev/null root pkill node');
  deny('timeout 5 {fd}>/dev/null pkill node');
  deny('pgrep -f x | xargs -n {fd}>/dev/null 1 kill');
  denyListing('{fd}>/dev/null ps aux');
  denyListing('command -- {fd}>/dev/null ps aux');
  deny("ps -p 1 '{x}'>/tmp/f; kill $X");
  allowListing('{fd}>/dev/null ls');
  allowListing('exec {fd}>/tmp/log');
});

// [denied command, the command its reason says to run instead]
const REPLACEMENTS = [
  ['pgrep -fl "git push" | head', "pgrep -d, -f 'git push' | xargs -r ps -o pid=,ppid=,etime=,comm= -p | head"],
  ['pgrep -l -f e2e-local', 'pgrep -d, -f e2e-local | xargs -r ps -o pid=,ppid=,etime=,comm= -p'],
  ['pgrep -fa node', 'pgrep -d, -f node | xargs -r ps -o pid=,ppid=,etime=,comm= -p'],
  ['pgrep -fl run-agent-gates || echo none', 'pgrep -f run-agent-gates || echo none'],
  ['pgrep -fl -u adrian node', 'pgrep -d, -f -u adrian node | xargs -r ps -o pid=,ppid=,etime=,comm= -p'],
  ['ps aux | grep -E "git push|husky" | grep -v grep | head -5', "pgrep -d, -f 'git push|husky' | xargs -r ps -o pid=,ppid=,pcpu=,rss=,etime=,comm= -p | head -5"],
  ['ps aux | grep "[g]it push\\|husky"', "pgrep -d, -f '[g]it push|husky' | xargs -r ps -o pid=,ppid=,pcpu=,rss=,etime=,comm= -p"],
  ['ps -axo pid,rss,command | grep -i next', 'pgrep -i -d, -f next | xargs -r ps -o pid=,rss=,comm= -p'],
  ['ps aux | grep node && echo up', 'pgrep -f node && echo up'],
  ['ps aux', 'ps -ax -o pid,ppid,pcpu,rss,etime,comm'],
  ['ps -ef', 'ps -e -o pid,ppid,pcpu,rss,etime,comm'],
  ['ps', 'ps -o pid,ppid,pcpu,rss,etime,comm'],
  ['ps -Ao pcpu,command -r | head -12', 'ps -Ar -o pcpu,comm | head -12'],
  ['ps -p 14274 -o pid,command | cat', 'ps -p 14274 -o pid,comm | cat'],
  ['ps -o pid,pcpu,etime,args -p $p 2>/dev/null | tail -1', 'ps -p "$p" -o pid,pcpu,etime,comm 2>/dev/null | tail -1'],
  ['ps -o "%p %a" -p 1', 'ps -p 1 -o pid,comm'],
  ['ps aux | grep -F a.b', 'ps -ax -o pid,ppid,pcpu,rss,etime,comm | grep -F a.b'],
  ['sudo ps aux', 'sudo ps -ax -o pid,ppid,pcpu,rss,etime,comm'],
  ['git status; pgrep -fl next | head; ps -p 1 -o command=', 'git status; pgrep -d, -f next | xargs -r ps -o pid=,ppid=,etime=,comm= -p | head; ps -p 1 -o comm='],
  ['echo "$(pgrep -fl next)"', 'echo "$(pgrep -d, -f next | xargs -r ps -o pid=,ppid=,etime=,comm= -p)"'],
];

test('a listing deny names first the exact command to run instead, and that command runs', () => {
  for (const [command, replacement] of REPLACEMENTS) {
    const { decision, reason } = decideForCommand(command, NO_OVERRIDE);
    assert.equal(decision, 'deny', command);
    assert.ok(reason.startsWith(`Blocked: this process listing prints full command lines. Run this instead:\n\n  ${replacement}\n`), `${command}\n${reason}`);
    assert.equal(check(replacement, { env: NO_OVERRIDE }), null, `the replacement passes the process rules: ${replacement}`);
    assert.equal(grepChainCheck(replacement, { env: {} }), null, `and the grep rule: ${replacement}`);
    assert.equal(firstSentence(reason), 'this process listing prints full command lines.', 'the dispatch log keys the rule as before');
    assertParses(replacement);
  }
});

// bash -n: the line parses. Skipped where bash is missing.
function assertParses(line) {
  const result = spawnSync('bash', ['-n', '-c', line], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, `bash -n: ${line}\n${result.stderr}`);
}

test('no whole-line replacement for a listing behind a shell word, in a group, or in a body that occurs twice', () => {
  const lead = 'Blocked: this process listing prints full command lines.';
  for (const command of ['(ps aux; echo done)', 'while pgrep -fl x; do sleep 1; done', '! pgrep -fl x', 'case $x in a) ps aux;; esac', 'ps aux | grep "(a|b)"']) {
    const { decision, reason } = decideForCommand(command, NO_OVERRIDE);
    assert.equal(decision, 'deny', command);
    assert.ok(!reason.includes('Run this instead'), `${command}\n${reason}`);
    assert.ok(reason.startsWith(lead), command);
  }
  const twice = decideForCommand(`echo '$(pgrep -fl x)' "$(pgrep -fl x)"`, NO_OVERRIDE).reason;
  assert.ok(!twice.includes('Run this instead') && twice.includes('in place of `pgrep -fl x`'), twice);
});

test('a listing inside a command string gets the replacement for that listing alone', () => {
  const { reason } = decideForCommand("sh -c 'pgrep -fl next'", NO_OVERRIDE);
  assert.ok(reason.includes('Run `pgrep -d, -f next | xargs -r ps -o pid=,ppid=,etime=,comm= -p` in place of `pgrep -fl next`.'), reason);
  assert.ok(decideForCommand('ps $FLAGS', NO_OVERRIDE).reason.startsWith(`Blocked: this process listing prints full command lines. On macOS`), 'none it cannot build');
});

test('a pkill or killall deny names the pgrep that lists what it would stop', () => {
  const pkill = decideForCommand('pkill -9 -f "next dev -p 3999"; sleep 2', ENV).reason;
  assert.ok(pkill.includes("List the pids first with `pgrep -f 'next dev -p 3999'`, then `kill <pid>` only those this session started."), pkill);
  const killall = decideForCommand('killall -KILL node next-server', ENV).reason;
  assert.ok(killall.includes("List the pids first with `pgrep -x 'node|next-server'`"), killall);
  assert.equal(firstSentence(pkill), firstSentence(decideForCommand('pgrep -x yes | xargs kill', ENV).reason), 'one key for the rule in the log');
  assert.ok(!decideForCommand('pgrep -x yes | xargs kill', ENV).reason.includes('List the pids first'));
});
