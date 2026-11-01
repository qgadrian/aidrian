---
type: regex
name: backs the flaw with the refunds doc section or a line of the code
pattern: 'refunds\.md[^\n]{0,160}store[- ]credit[- ]stays[- ]credit|store[- ]credit[- ]stays[- ]credit[^\n]{0,160}refunds\.md|(?:refunds\.md|checkout\.js|orders\.js)(?::| lines? |#?L)\d+'
flags: i
---
