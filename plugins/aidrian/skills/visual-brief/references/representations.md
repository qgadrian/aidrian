# Build the visual and reading path

Decide what the reader needs from the brief before choosing its layout.

| Reader's task | Reading path | Main representation |
| --- | --- | --- |
| Understand the takeaways | Answer first, then the evidence that explains or qualifies it | Timeline for dated events, directly labeled chart for numerical change, or headings for a few findings |
| Review a change | State the examined scope, then order findings by impact and tie them to behavior and test coverage | Align before and after on like dimensions, with exact locations for findings |
| Choose among options | Show the sourced constraints, the trade-offs, and a recommendation or unresolved choice | Compare the options on the same criteria in a table and label assumptions |
| Understand how something works | Walk one representative case from input to outcome | Use a flow or state diagram where order, branches, or transitions matter |

For a short supplied-note brief, use the answer, one representation, and a compact source list. Headings or a table can be enough.
Use a linked contents list for longer documents. Label chart values directly with units, denominators, and time ranges. Explain every
meaningful diagram node and relationship through the cited evidence, or mark it as inferred. Put contrasting states side by side when
comparison matters, and allow them to stack on a narrow screen while keeping their labels.

Use a descriptive title, document language, structured headings, a main landmark, and a viewport declaration. Give figures an
equivalent text explanation, label any data table, and use high-contrast text and visible keyboard focus. Keep tables and long excerpts
from creating page-wide horizontal scrolling. Use native `details` and `summary` for optional, keyboard-operable detail. Preserve the
answer, main visual or its text equivalent, and citations in print reading order.

Write one document with inline styles, system fonts, and static authored HTML or inline SVG. Allow internal anchor jumps and
clickable citations only. Use HTTPS where available and omit URL credentials, signed parameters, and private addresses or identifiers. Quote HTML and SVG
attribute values and use simple fragment IDs for internal links. CSS and SVG paint may refer to same-document IDs such as `url(#shade)`.
Give external citations `rel="noreferrer"` and avoid automatic navigation. Use a restrictive content security policy as a second check
on resource loading and executable content. For a brief with inline styles and no other resources, put this early in the head:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
```
