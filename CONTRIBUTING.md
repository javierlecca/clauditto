# Contributing to Clauditto

Thanks for wanting to help out — this is pretty informal, no bureaucratic
process here.

## Before writing code

For something small (a bug fix, a typo, a UI tweak), go straight to a PR.

For something bigger (a new feature, an architecture change), open an
[issue](../../issues) first describing the idea — it saves you from working
on something that ends up not fitting where the project is headed.

## How it's organized

- `src/main/` — Electron's main process (sessions, filesystem, pty).
- `src/preload/` — the bridge (`contextBridge`) between main and renderer.
- `src/renderer/src/core/` — pure renderer logic (testable without a DOM).
- `src/renderer/src/views/` — the DOM, thin, built on top of `core/`.
- See [`docs/renderer-refactor-checklist.md`](docs/renderer-refactor-checklist.md)
  for the reasoning behind that split.

## Workflow

```bash
npm install
npm run dev     # launch the app in development mode
npm test        # run the test suite (vitest)
```

1. Fork the repo and create a descriptive branch.
2. If you touch `core/` logic, add a test — that's what keeps that layer
   reliable without any DOM or Electron involved.
3. Before opening the PR: `npm test` green.
4. Describe in the PR what changes and why, not just what.

## What to avoid

- Huge PRs that mix several unrelated things — several small, focused ones
  are better.
- New dependencies for something that's easy to solve by hand (the project
  is deliberately light on dependencies).

Any doubts, open an issue and we'll sort it out there.
