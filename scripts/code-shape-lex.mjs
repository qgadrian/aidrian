// The tokenizer behind scripts/code-shape.mjs: enough of JavaScript to tell code from strings, template text,
// regular expressions, and comments, and to match brackets. It needs no dependency because it is not a parser.

// The operators longer than one character, longest first, so the tokenizer takes the longest that fits.
const OPERATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
];
// The words after which a `/` starts a regular expression rather than a division.
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
export const OPENERS = new Set(['(', '[', '{', '${']);
export const CLOSERS = new Set([')', ']', '}']);
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

// The source as tokens: { type: 'word' | 'punct' | 'str' | 'regex', value, line }. A string or a piece of template
// text is one 'str' token whose value is its opening quote; `${` is a 'punct' token closed by `}`.
export function lex(source) {
  const state = { src: source, i: 0, line: 1, tokens: [], braces: [] };
  while (state.i < source.length) step(state);
  return state.tokens;
}

function step(state) {
  const { src, i } = state;
  const char = src[i];
  if (/\s/u.test(char)) return advance(state, i + 1);
  if (src.startsWith('//', i)) return skipLineComment(state);
  if (src.startsWith('/*', i)) return advance(state, endOf(src, '*/', i + 2));
  if (char === '"' || char === "'") return readString(state, char);
  if (char === '`') return readTemplate(state, i + 1);
  if (char === '/' && regexAllowed(state.tokens.at(-1))) return readRegex(state);
  if (WORD_CHAR.test(char)) return readWord(state);
  readPunct(state);
}

// Moves to `end`, counting the newlines passed.
function advance(state, end) {
  for (let k = state.i; k < end; k++) if (state.src[k] === '\n') state.line++;
  state.i = end;
}

function push(state, type, value, line = state.line) {
  state.tokens.push({ type, value, line });
}

// The index just past `marker` from `from`, or the end of the source when it never comes.
function endOf(src, marker, from) {
  const found = src.indexOf(marker, from);
  if (found === -1) return src.length;
  return found + marker.length;
}

function skipLineComment(state) {
  const found = state.src.indexOf('\n', state.i);
  state.i = found === -1 ? state.src.length : found;
}

function readString(state, quote) {
  const { src } = state;
  let k = state.i + 1;
  while (k < src.length && src[k] !== quote && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
  push(state, 'str', quote);
  advance(state, k + 1);
}

// Template text from `from` up to the closing backtick, or up to a `${`, whose expression the tokenizer then reads as code.
function readTemplate(state, from) {
  const { src } = state;
  let k = from;
  while (k < src.length && src[k] !== '`' && !src.startsWith('${', k)) k += src[k] === '\\' ? 2 : 1;
  push(state, 'str', '`');
  if (!src.startsWith('${', k)) return advance(state, k + 1);
  advance(state, k + 2);
  state.braces.push('${');
  push(state, 'punct', '${');
}

// SHORTCUT: judged by the token before, which misreads a regular expression right after a block's `}` or a control
// head's `)`, as in `if (x) /re/.test(s)`, and a division right after a postfix `++` or `--`; a parser would know the
// grammar there.
function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === 'word') return REGEX_AFTER.has(prev.value);
  if (prev.type === 'punct') return !CLOSERS.has(prev.value);
  return false;
}

// A regular expression literal; a `/` whose line ends before a closing `/` was a division after all.
function readRegex(state) {
  const { src } = state;
  let k = state.i + 1;
  let inClass = false;
  while (k < src.length && src[k] !== '\n' && (inClass || src[k] !== '/')) {
    if (src[k] === '[') inClass = true;
    if (src[k] === ']') inClass = false;
    k += src[k] === '\\' ? 2 : 1;
  }
  if (src[k] !== '/') return readPunct(state);
  k++;
  while (k < src.length && WORD_CHAR.test(src[k])) k++;
  push(state, 'regex', src.slice(state.i, k));
  state.i = k;
}

function readWord(state) {
  const { src } = state;
  let k = state.i;
  while (k < src.length && WORD_CHAR.test(src[k])) k++;
  push(state, 'word', src.slice(state.i, k));
  state.i = k;
}

function readPunct(state) {
  const { src, i } = state;
  const value = OPERATORS.find((operator) => src.startsWith(operator, i) && !isDecimalAfterQuestion(src, operator, i)) ?? src[i];
  state.i = i + value.length;
  push(state, 'punct', value);
  if (value === '{') state.braces.push('{');
  if (value !== '}') return;
  // A `}` that closes a template's `${` goes back to the template text.
  if (state.braces.pop() === '${') readTemplate(state, state.i);
}

// `a?.5:1` is a ternary on the number .5, not optional chaining.
function isDecimalAfterQuestion(src, operator, i) {
  return operator === '?.' && /\d/u.test(src[i + 2] ?? '');
}

// Each bracket's index mapped to its partner's, both ways.
export function matchBrackets(tokens) {
  const match = new Map();
  const stack = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'punct') return;
    if (OPENERS.has(token.value)) stack.push(index);
    if (!CLOSERS.has(token.value) || stack.length === 0) return;
    const open = stack.pop();
    match.set(open, index);
    match.set(index, open);
  });
  return match;
}
