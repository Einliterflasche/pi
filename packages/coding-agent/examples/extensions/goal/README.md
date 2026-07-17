# Goal Loop

Bundled extension for bounded, condition-driven continuation. `/goal` starts work immediately, evaluates the settled result with the active session model and thinking level, and continues until the evaluator finds the objective complete or a safety limit pauses the loop.

## Commands

```text
/goal [--turns N] [--tokens N] [--minutes N] <objective>
/goal status
/goal pause
/goal resume
/goal edit <objective>
/goal clear
```

Agent-run, token, and time limits are unlimited unless their options are provided. Three evaluations without material progress or two repetitions of the same blocker pause the goal.

Goal state and evaluations are stored in the session. Resumed sessions and changed session branches leave active goals paused until `/goal resume` is issued. The footer shows the active or paused goal budget and temporarily displays `goal evaluating…` during evaluation.

The evaluator uses the model and thinking level active at evaluation time. It judges completion from transcript evidence and may include an optional hint only when the agent is missing materially useful information; it does not plan or orchestrate the work. It has no tools and cannot elevate permissions. Continuations are tagged `goal_continuation` custom messages rather than user messages, and all agent work keeps the session's current permission mode.

`--no-extensions` disables this workflow along with the other bundled extensions.
