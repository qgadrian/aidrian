---
type: regex
name: no required change adds or keeps the dedupe table
pattern: '(?:^|\n)[ \t]*(?:\d+[.)][ \t]*)?(?:(#{1,6})[ \t]*(?:\d+[.)][ \t]*)?Required changes[^\n]*\n(?:(?:(?!#+[ \t])|(?=\1#))[^\n]*\n)*?|\*\*Required changes[^\n]*\n(?:(?![ \t]*(?:\d+[.)][ \t]*)?\*\*[^\n*]+\*\*|#+[ \t])[^\n]*\n)*?)[ \t]*(?:[-*+]|\d+[.)]|\|(?:[^|\n]*\|)?)[ \t]+(?:(?!\b(?:no|not|never|without|instead|rather|drop|drops|remove|cut|delete|replace|skip)\b|n''t)[^\n]){0,60}?(?:\b(?:add|adds|adding|keep|keeps|keeping|build|builds|building|require|requires|requiring)\b(?:(?!\b(?:no|not|never|without|instead|rather|drop|drops|remove|cut|delete|replace|skip)\b|n''t)[^\n]){0,80}?(?:dedup|de-dup|refunded[- ]order[- ]ids?|table of refunded)|(?:dedup|de-dup|refunded[- ]order[- ]ids?|table of refunded)(?:(?!\b(?:no|not|never|without|instead|rather|drop|drops|remove|cut|delete|replace|skip)\b|n''t)[^\n]){0,40}?\b(?:add|keep|build|require)\b)'
flags: i
match: not_contains
---
