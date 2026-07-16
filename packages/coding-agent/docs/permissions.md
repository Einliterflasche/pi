# Tool Permissions

Interactive mode starts in `manual` permission mode. Press `Shift+Tab` or use `/permissions` to switch modes.

| Mode | Indicator | Behavior |
|---|---|---|
| Manual | gray `⏸` | Built-in `read` and `grep` run directly. Every other tool call requires one-time approval. |
| Read only | green `⏸` | Only the verified built-in `read`, `grep`, `find`, and `ls` tools are available. Other calls are denied without prompting. |
| Auto (read only) | accent `▣` | Calls are reviewed by the active model and approved only when verifiably non-altering. Ambiguous calls are denied. |
| Auto | yellow `⏵⏵` | Non-exempt calls are reviewed by the active model before execution. |
| Skip | red `⏵⏵` | Every tool call runs without approval. |

Permission mode is runtime-only and resets to `manual` when pi starts.

## Read-only operation

Read-only mode temporarily replaces the active tool set with the verified built-in `read`, `grep`, `find`, and `ls` tools. The previous active tool set is restored when leaving the mode. Extension tools and built-in tools overridden by extensions are not trusted as read-only, even when they use the same names.

The system prompt instructs the agent to complete as much work as possible with read-only access. If the goal requires mutation or side effects, the agent must report what it could not complete and ask the user to switch to a broader permission mode. Disallowed tool calls are denied directly and never open an approval prompt.

## Automatic read-only classification

Automatic read-only mode keeps the normal tool set available but requires the classifier to verify that each non-exempt call is non-altering and has no local or remote side effects. Writes, edits, state-changing commands, configuration changes, package operations, network mutations, mixed commands, and ambiguous operations are denied.

Classifier transport or schema failure is also denied because the call cannot be verified as read-only. Unlike standard automatic mode, it never falls back to a manual approval prompt. The system prompt tells the agent to use only verifiably read-only operations and to report failure and request a broader mode when necessary.

## Automatic classification

The classifier receives only user-authored messages, the proposed tool call, the working directory, and whether the working directory is version controlled. It does not receive assistant messages, reasoning, tool results, extension messages, or the normal system prompt.

The response must be exactly one of:

```json
{"approved":true}
```

```json
{"approved":false,"reason":"brief reason"}
```

Classifier transport and schema failures are retried up to three times. In interactive mode, repeated classifier failure falls back to a manual prompt. Classifier failures do not count as permission denials.

After five consecutive classifier denials, tool execution pauses until the user sends another message. The agent is instructed to explain the blocked operation and ask for explicit approval.

The classifier judges whether the user could reasonably expect the proposed access and scope. Version-controlled project edits are lower risk. System changes, privilege escalation, deployment, publishing, operating-system updates, destructive Git operations, credential access, data deletion, and irreversible or remote actions require explicit intent.
