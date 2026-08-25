# Agent Instructions

## Graphify — use it instead of manual grep for architecture questions

This project has a local knowledge graph at `graphify-out/graph.json` (cross-file relationships,
god nodes, community structure). For "how does X connect to Y", "what touches this", or general
architecture-navigation questions, query it FIRST instead of a manual grep/read sweep — it
returns a scoped subgraph, usually much smaller than raw grep output or `GRAPH_REPORT.md`:

```powershell
uv --cache-dir .uv-cache-cli tool run --from graphifyy graphify query "<question>" --graph graphify-out/graph.json
uv --cache-dir .uv-cache-cli tool run --from graphifyy graphify path "<A>" "<B>" --graph graphify-out/graph.json
uv --cache-dir .uv-cache-cli tool run --from graphifyy graphify explain "<concept>" --graph graphify-out/graph.json
uv --cache-dir .uv-cache-cli tool run --from graphifyy graphify affected "<symbol>" --graph graphify-out/graph.json
```

`--cache-dir .uv-cache-cli` is required, not optional: the background `graph:watch` process (below)
keeps its own `graphifyy` binary running and locked, and on Windows any `uvx`/`uv tool run` call
that shares the default cache with a locked file fails with `os error 183`. Every ad-hoc call must
use its own cache dir, separate from the watcher's — do not drop this flag or fall back to plain
`uvx --from graphifyy ...`.

Only fall back to grep/read when the graph doesn't surface enough (query/path/explain come back
empty or too coarse), or the user explicitly says not to use it. Read `GRAPH_REPORT.md` only for
a broad architecture review, not for a specific question.

The graph stays current on its own: `npm run dev` runs a background `graph:watch` process
(`uv --cache-dir .uv-cache-watch tool run --from graphifyy --with watchdog graphify watch .`) that
rebuilds it automatically (AST-only, no LLM cost) whenever a source file changes. If the dev server
isn't running, refresh it by hand before relying on it:
`uv --cache-dir .uv-cache-cli tool run --from graphifyy graphify update crypto` from the `vantage` directory.

## Maintain a `progress.md` file in the project root.

After every meaningful action, append:

- Date and time
- Step completed
- Files inspected or changed
- Decision made and reason
- Agent name and model: Codex luna medium, Claude etc.
- Test result
- Errors or unresolved items
- Next step

Rules:

- Append only; never delete previous entries.
- Keep entries short and factual.
- Do not log API keys, tokens, passwords, or sensitive values.
- Update `progress.md` before finishing each task.

## UI strings

User-facing text in `ui/` (labels, button text, tooltips, error/empty-state messages) goes in
`ui/strings.ts`, not inline in JSX. Add new copy there and reference it, instead of writing a new
string literal at the call site.

## Future implementation ideas

When the user writes `idea: ...`, treat the text after `idea:` as an idea to record, not as an immediate implementation request. Append it with the current date to [`ideas-for-future-implementation.md`](./ideas-for-future-implementation.md). Keep the wording concise, preserve the user's intent, and do not modify source code unless the user separately asks to implement the idea.

## Local development tooling

- Use `npm run arch:check` for the dependency-cruiser architecture check. Its rules live in `.dependency-cruiser.cjs`.
- Use the project-local `.mcp.json` when the active coding agent supports MCP. Context7 is for current library/API documentation; Serena is for symbol-aware TypeScript navigation and refactoring.

## Spec Kit — automatic workflow

Spec Kit is part of the normal agent workflow for substantial or evidence-sensitive changes.
Before editing source, classify the request. A Spec Kit workflow is mandatory when the change:

- spans two or more layers such as database, domain logic, server/API, UI, extension, or Python research code;
- changes a research definition, decision rule, score, coverage rule, provenance rule, or Pattern Discovery behavior;
- adds or changes a provider integration, SQLite migration, persisted cache, long-running job, worker, or resumability behavior;
- changes an API contract used by another layer; or
- is described as architectural, structural, a redesign, or a new feature.

For a mandatory workflow, use the official `specify` CLI and the existing `.specify/` integration to create or extend a feature specification before implementation. Follow the project workflow in this order:

1. specify the goal, scope, non-goals, current-code evidence, invariants, and acceptance criteria;
2. review and resolve ambiguities in the generated specification;
3. generate the implementation plan, including affected modules, migrations, API/UI contracts, and verification;
4. review the plan before coding;
5. generate ordered implementation tasks with tests and quality gates;
6. implement the tasks and keep the spec, plan, and tasks synchronized with material decisions.

Do not create a second parallel spec when a matching feature spec already exists; inspect and extend it. Do not treat retrospective specs in `.specify/specs/` as authorization for new behavior. Read `docs/BROWNFIELD_SYSTEM_BASELINE.md` and verify current source before converting historical research notes into requirements.

Spec Kit is not required for isolated copy, styling, documentation, mechanical, or clearly local bug fixes that do not change a contract or invariant. When skipping it, record the reason in `progress.md`. For every mandatory workflow, run the relevant build/tests and `npm run arch:check` for structural changes, then append the outcome and unresolved items to `progress.md`.

## Brownfield baseline

- Read `docs/BROWNFIELD_SYSTEM_BASELINE.md` before making architectural or cross-layer changes.
- Treat current TypeScript routes, SQLite migrations, tests, and runtime behavior as the source of
  truth. `progress.md`, `research/`, and `.specify/specs/` may contain historical or prospective
  material and must be checked against code.
- Keep retrospective specs separate from future feature specifications; do not turn historical
  proposals into implied requirements.
