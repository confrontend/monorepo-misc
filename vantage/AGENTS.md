## graphify

This project has a knowledge graph at crypto/graphify-out/ with god nodes, community structure, and cross-file relationships. The first indexed surface is the crypto application; other top-level projects should be added deliberately rather than swept into the same graph.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For crypto codebase questions, first run `graphify query "<question>" --graph crypto/graphify-out/graph.json` when that graph exists. Use `graphify path "<A>" "<B>" --graph crypto/graphify-out/graph.json` for relationships and `graphify explain "<concept>" --graph crypto/graphify-out/graph.json` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty crypto/graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If crypto/graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read crypto/graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After every modification to crypto source code, run `uvx --from graphifyy graphify update crypto` from the `vantage` repository root to keep the graph current. This is mandatory before finishing the task (AST-only, no API cost).

## Future implementation ideas

When the user writes `idea: ...`, treat the text after `idea:` as an idea to record, not as an immediate implementation request. Append it with the current date to [`ideas-for-future-implementation.md`](./ideas-for-future-implementation.md). Keep the wording concise, preserve the user's intent, and do not modify source code unless the user separately asks to implement the idea.
