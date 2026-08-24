## Future implementation ideas

When the user writes `idea: ...`, treat the text after `idea:` as an idea to record, not as an immediate implementation request. Append it with the current date to [`ideas-for-future-implementation.md`](./ideas-for-future-implementation.md). Keep the wording concise, preserve the user's intent, and do not modify source code unless the user separately asks to implement the idea.

## Engineering Conventions

Before making any code changes, read and follow `CONVENTIONS.md` in this repository root.

These conventions apply to all projects in this repository unless a more specific project-level `AGENTS.md` or convention file overrides them.

When modifying existing code, preserve the project's established architecture, folder structure, naming, and patterns. Prefer reusing and extending existing shared logic and components instead of creating parallel implementations.

## Brownfield documentation

For existing projects, establish or update the project's brownfield baseline before structural
changes. Treat current source code, migrations, tests, and route behavior as authoritative; use
`progress.md` and research/spec documents as history unless verified in code. Separate retrospective
baseline records from future implementation specs.

## Development tooling

- The `crypto` project is the TypeScript application in this repository.
- Run `npm run arch:check` from `crypto` before merging structural changes. It uses dependency-cruiser and `.dependency-cruiser.cjs` to enforce the project dependency boundaries.
- Keep generated/build/vendor output out of source analysis. The configured exclusions include `node_modules`, `dist`, `dist-ui`, `build`, `coverage`, `graphify-out`, `src/.data`, secrets, mockups, research, and generated files.
- When supported by the active agent, use the project-local `.mcp.json` servers: Context7 for current third-party documentation and Serena for symbol-aware TypeScript navigation/refactoring. These tools are optional developer tooling and are not runtime dependencies.
- Use Spec Kit's `specify` CLI for spec-driven work when a change benefits from an explicit constitution/spec/plan/tasks workflow. Do not run initialization over an existing project without checking the generated files first.
