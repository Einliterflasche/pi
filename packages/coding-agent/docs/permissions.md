# Tool Permissions

Interactive mode starts in `manual` permission mode. Press `Shift+Tab` or use `/permissions` to switch modes.

| Mode | Indicator | Behavior |
|---|---|---|
| Manual | gray `⏸` | Built-in `read` and `grep` run directly. Every other tool call requires one-time approval. |
| Auto | yellow `⏵⏵` | Non-exempt calls are reviewed by the active model before execution. |
| Skip | red `⏵⏵` | Every tool call runs without approval. |

Permission mode is runtime-only and resets to `manual` when pi starts.

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
