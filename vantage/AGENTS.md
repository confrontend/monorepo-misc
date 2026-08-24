## Future implementation ideas

When the user writes `idea: ...`, treat the text after `idea:` as an idea to record, not as an immediate implementation request. Append it with the current date to [`ideas-for-future-implementation.md`](./ideas-for-future-implementation.md). Keep the wording concise, preserve the user's intent, and do not modify source code unless the user separately asks to implement the idea.

## Engineering Conventions

Before making any code changes, read and follow `CONVENTIONS.md` in this repository root.

These conventions apply to all projects in this repository unless a more specific project-level `AGENTS.md` or convention file overrides them.

When modifying existing code, preserve the project's established architecture, folder structure, naming, and patterns. Prefer reusing and extending existing shared logic and components instead of creating parallel implementations.
