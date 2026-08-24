# Engineering Conventions

These rules apply to all projects in this repository unless a project defines stricter local conventions.

## General
- Prefer simple, readable code over clever abstractions.
- Follow DRY: search for existing code before creating new code.
- Keep functions and modules focused on one responsibility.
- Match existing architecture, folder structure, and domain conventions.
- Keep projects structurally consistent with each other where practical.
- Do not introduce new dependencies unless necessary.
- Add or update tests when changing important behavior.

## Shared Logic
- Before implementing new logic, check whether similar logic already exists.
- Business and decision-making logic must have a single shared implementation.
- Never implement separate versions of the same calculation, financial rule, decision engine, or backtesting logic in different parts of the application.
- Any part of the system needing the same behavior should call the shared implementation.
- Accuracy and consistency take priority over convenience, especially for financial calculations and backtesting.

## Strings
- Keep user-facing English text and similar strings centralized in one strings/messages file or module per application.
- Do not scatter hard-coded user-facing strings throughout components.
- Access strings through the centralized module/object rather than creating and importing individual string constants.

## React + TypeScript
- Use TypeScript; avoid `any` unless unavoidable.
- Prefer small, focused components.
- Keep business logic out of UI components.
- Reuse existing components, hooks, types, and utilities before creating new ones.
- Shared UI patterns must use shared components.
- For example, use one reusable data table component rather than implementing multiple tables directly with repeated HTML.
- Keep project-specific code inside its project; place genuinely shared code in an appropriate shared module/package.

## Python
- Use type hints for public functions and important internal APIs.
- Keep route/controller code thin; place business logic in services or domain modules.
- Reuse existing models, schemas, utilities, services, and calculation logic.
- Keep database and external-service access separated from core business logic.

## Repository Structure
- This repository may contain multiple applications.
- Respect each application's boundaries and existing structure.
- Follow established conventions such as domain-driven design, module boundaries, and folder organization when present.
- Prefer similar structures and naming conventions across applications.
- Do not create cross-project dependencies unless they are intentional and clearly shared.