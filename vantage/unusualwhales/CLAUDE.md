# Agent Instructions

Maintain a `progress.md` file in the project root.

After every meaningful action, append:

* Date and time
* Step completed
* Files inspected or changed
* Decision made and reason
* Agent name and model: Codex, Claude, etc.
* Test result
* Errors or unresolved items
* Next step

Rules:

* Append only; never delete previous entries.
* Keep entries short and factual.
* Do not log API keys, tokens, passwords, or sensitive values.
* Update `progress.md` before finishing each task.

Final Goal Check

At the end of every meaningful task, briefly confirm: (1) the final goal is to determine whether Unusual Whales data contains repeatable, backtestable signals that could make money, (2) how the work just completed contributes to that goal, and (3) whether the project is still on track. Keep this to 2–3 short sentences. If the work does not clearly support the final goal, say so instead of continuing to add unnecessary complexity.