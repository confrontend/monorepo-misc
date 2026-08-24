# Agent Instructions

## Graphify — use it instead of manual grep for architecture questions

This project has a local knowledge graph at `graphify-out/graph.json` (cross-file relationships,
god nodes, community structure). For "how does X connect to Y", "what touches this", or general
architecture-navigation questions, query it FIRST instead of a manual grep/read sweep — it
returns a scoped subgraph, usually much smaller than raw grep output or `GRAPH_REPORT.md`:

```powershell
uvx --from graphifyy graphify query "<question>" --graph graphify-out/graph.json
uvx --from graphifyy graphify path "<A>" "<B>" --graph graphify-out/graph.json
uvx --from graphifyy graphify explain "<concept>" --graph graphify-out/graph.json
uvx --from graphifyy graphify affected "<symbol>" --graph graphify-out/graph.json
```

Only fall back to grep/read when the graph doesn't surface enough (query/path/explain come back
empty or too coarse), or the user explicitly says not to use it. Read `GRAPH_REPORT.md` only for
a broad architecture review, not for a specific question.

The graph stays current on its own: `npm run dev` runs a background `graph:watch` process
(`uvx --from graphifyy --with watchdog graphify watch .`) that rebuilds it automatically (AST-only,
no LLM cost) whenever a source file changes. If the dev server isn't running, refresh it by hand
before relying on it: `uvx --from graphifyy graphify update crypto` from the `vantage` directory.

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

## Future implementation ideas

When the user writes `idea: ...`, treat the text after `idea:` as an idea to record, not as an immediate implementation request. Append it with the current date to [`ideas-for-future-implementation.md`](./ideas-for-future-implementation.md). Keep the wording concise, preserve the user's intent, and do not modify source code unless the user separately asks to implement the idea.
