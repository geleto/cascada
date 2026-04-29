# Documentation Example Tests

This folder contains hand-curated examples from the public docs and README that are worth executing as tests.

The goal is not to scrape documentation or test every tiny snippet. Very small examples such as a single `return`, a simple variable assignment, or plain interpolation are already covered elsewhere and are easy to inspect by eye.

Add examples here when a snippet has enough structure to hide subtle mistakes:

- channel writes and `snapshot()`
- `guard` / `recover`
- `!`, `!!`, or `sequence`
- loops, especially concurrent `for` or template `asyncEach`
- functions, macros, inheritance, or composition
- syntax that differs between Script and Template

Keep examples inline in `examples.js`, close to the literal docs snippets, so they are easy to review alongside their assertions. Use `StringLoader` only when an example genuinely requires named files, such as inheritance or composition.
