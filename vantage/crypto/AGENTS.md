# Agent Instructions

The single source of truth for agent instructions is [`CLAUDE.md`](./CLAUDE.md).

Read and follow `CLAUDE.md` for this project. In particular, apply its automatic Spec Kit
workflow before cross-layer, architectural, research-validity, persistence, provider, API
contract, or Pattern Discovery changes. Do not bypass the specify → review → plan → review →
tasks → implement sequence for those changes; use the existing `.specify/` artifacts and keep
the brownfield baseline separate from future feature specifications.

## Reusable modules first

Before adding logic to a component, check whether it belongs in a reusable module, hook, or shared
component. Put reusable behavior there first, then keep the component as a thin consumer. Avoid
embedding persistence, calculations, formatting, or repeated UI behavior directly in a page or
panel when another part of the project could reasonably reuse it.

## Database migrations

Treat applied migrations as immutable history. Never edit an existing migration to add a column or
change its behavior; append a new migration instead. Keep runtime-critical table/column contracts
in a separate verifier and run that verifier immediately after migrations during database startup.
