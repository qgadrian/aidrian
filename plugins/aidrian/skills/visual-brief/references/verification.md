# Verify the brief before delivery

Use the checklist in order. Use the exact staged bytes for static and preview checks, and repeat affected checks after edits.

1. **Inspect and check offline markup before opening.** Read the raw document to confirm that source markup is escaped,
   sensitive data and private locators are absent, and only approved HTTP(S) citations leave the page on click. Run
   `node "<skill-directory>/scripts/check-offline.mjs" "<staged-html>"` with Node 22 or later. This check accepts the
   brief's static HTML and SVG, quoted attribute values, inline CSS without remote resources, and citation links. Exit 0 means
   it found no violations. Exit 1 reports the first rule and line. Repair the markup and rerun the check. Exit 2 indicates a usage
   or read error. Resolve it before preview or delivery. When Node or command execution is unavailable, manually inspect the
   exact markup and CSS for scripts, event handlers, active SVG, external resource loads, forms, frames, automatic navigation,
   network hints, and browser persistence. Report the manual fallback. Keep browser isolation as a separate check.
2. **Scan the secrets.** Run `node "<skill-directory>/scripts/check-secrets.mjs" "<staged-html>"` with Node 22 or later, resolving
   `<skill-directory>` to the directory containing `SKILL.md`. A clean scan exits 0. Exit 1 prints only rule names and input line numbers.
   Repair findings privately and scan again. Exit 2 indicates a usage or read error. Resolve it before delivery. If Node or command execution
   is unavailable, manually recheck for credential signatures, private-key headers, credential values in headers and assignments, URL
   credentials, and signed URL fields, including HTML-escaped forms. Report the manual check and why the checker did not run. The checker
   supplements source review and redaction.
3. **Establish preview isolation.** Use an authorized local or private workspace browser whose outbound page networking can be blocked.
   Enable isolation before opening the document and confirm that the browser can observe attempted requests while blocking egress.
   An artifact's content security policy alone cannot establish preview isolation. If the browser is missing or cannot isolate egress,
   finish the static checks and state why preview was unavailable.
4. **Preview.** Load the staged file under isolation. Record any outbound page requests attempted during initial rendering, anchor use,
   and disclosure use. A passing run has zero. Check console and runtime errors, internal links and targets, keyboard focus and disclosure
   behavior, main visual legibility and reflow at 1280 px and 320 px, absence of page-wide horizontal scrolling, and print reading order.
   Leave outbound citation links unvisited during this check. If a preview check is unavailable, record the gap.
5. **Fix and verify the final bytes.** Fix observed failures. Repeat static and secret checks before reopening a file with changed markup,
   resources, or executable content. Rerun the affected preview checks and ensure the secret scan or manual fallback covers the final bytes.

## Retain at an authorized local path

Use an atomic operation that exposes only complete, verified bytes and preserves owner-only access at every point. Keep the original
staged artifact available until retention and private requester access are verified. Use create-only publication by default. Use atomic
replacement only for the specific file the requester authorized replacing. With a local filesystem, stage a private copy on the destination
filesystem if necessary, check that its bytes match, then use a create-only hard link or an authorized atomic rename. Create any temporary
copy with mode 0600 or equivalent before writing its bytes. Use only an operation and destination whose ownership and access controls
keep the retained file private and allow the requester to retrieve it.

If the host cannot establish the requested atomic or access guarantees, leave the destination untouched. On a collision or failure before
publication, preserve any existing file and keep the staged artifact. Report the fallback and link the staged file if the requester can
access it privately.
