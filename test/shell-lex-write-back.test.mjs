import assert from 'node:assert/strict';
import test from 'node:test';

import { excerpt, lexCommand, lexPipeline, shellRedirections, shellWord } from '../plugins/aidrian/lib/shell-lex.mjs';

// What the lexer keeps so a rule can quote a command back: where each segment sits, a redirection's fd, a substitution
// it could not keep, and the words written back as the shell reads them.
const texts = (line) => lexCommand(line).map((segment) => segment.map((token) => token.text));

test('lexPipeline gives where each segment sits in the line, without its separator or the spaces around it', () => {
  const line = 'a && grep -c x "f g" | wc -l ;  b  ';
  const { spans } = lexPipeline(line);
  assert.deepEqual(spans.map(([start, end]) => line.slice(start, end)), ['a', 'grep -c x "f g"', 'wc -l', 'b']);
  const heredoc = 'cat <<EOF | grep -c x && y\nbody\nEOF\nnext';
  assert.deepEqual(lexPipeline(heredoc).spans.map(([start, end]) => heredoc.slice(start, end)), ['cat <<EOF', 'grep -c x', 'y', 'next']);
});

test('a redirection keeps its fd, and an unquoted substitution marks its token', () => {
  const [segment] = lexCommand('ps aux 2>/dev/null >/dev/null');
  assert.deepEqual(segment.filter((token) => token.operator).map((token) => token.fd), ['2', undefined]);
  assert.equal(lexCommand('kill $(cat pid)')[0][1].substituted, true);
  assert.equal(lexCommand('kill "$(cat pid)"')[0][1].substituted, undefined, 'a quoted one keeps its body in the text');
});

test('inside double quotes a backslash escapes only $, a backtick, ", \\, and a newline', () => {
  assert.deepEqual(texts('grep "a\\|b" f'), [['grep', 'a\\|b', 'f']], "grep's \\| keeps its backslash, as bash passes it");
  assert.deepEqual(texts('echo "\\$HOME \\" \\\\"'), [['echo', '$HOME " \\']]);
});

test('shellWord writes a token back as the same word, or null when the lexer kept too little', () => {
  const words = (line) => lexCommand(line)[0].map(shellWord);
  assert.deepEqual(words(`pgrep -f "git push" 'it'"'"'s' "$F" x.log`), ['pgrep', '-f', "'git push'", "'it'\\''s'", '"$F"', 'x.log']);
  assert.deepEqual(words('kill $(cat pid) `cat pid`'), ['kill', null, null]);
  assert.deepEqual(shellRedirections(lexCommand('ps -p 1 2>/dev/null >out 2>&1')[0]), ['2>/dev/null', '>out', '2>&1']);
});

test('excerpt keeps a short text whole and cuts a long one around the part that matters', () => {
  assert.equal(excerpt('short', 0, 1), 'short');
  const long = `${'a'.repeat(700)}MIDDLE${'b'.repeat(700)}`;
  const cut = excerpt(long, 700, 706, 100);
  assert.ok(cut.startsWith('…') && cut.endsWith('…') && cut.includes('MIDDLE'));
});
