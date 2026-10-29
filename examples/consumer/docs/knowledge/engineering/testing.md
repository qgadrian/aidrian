# Testing

- Unit tests sit next to the code they test, named `<module>.test.js`.
- Run all tests with `node --test`. A change is not done until they pass.
- Every rule in `docs/knowledge/product/` that code enforces has a test that names the rule.
- Do not mock the module under test. Mock only the network and the clock.
