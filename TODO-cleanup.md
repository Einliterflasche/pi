# Fork Cleanup TODO

This file tracks fork-specific architectural cleanup found during the read-only review. The focus is on removing split ownership, paired operations callers must remember, and lifecycle state that can become stale.

## Priority 1: Permission and editor ownership

### Make `AgentSession` the sole permission-mode owner

Files:

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Current problem:

- `InteractiveMode` stores a permission mode for UI and session replacement.
- `AgentSession` stores the effective mode used for enforcement.
- Every mutation and session replacement must synchronize both values.
- A direct `session.setPermissionMode()` can make enforcement and display disagree.

Target design:

- Store permission mode in one authoritative owner.
- Expose a mode-change notification from the session/runtime.
- Have permission selectors, cycling, extension contexts, and indicators derive from that state.
- Preserve the authoritative state intentionally across session replacement.

### Introduce a typed editor-host contract

File: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Current problem:

Custom editor installation manually propagates:

- callbacks
- text
- appearance
- autocomplete
- app action handlers
- working status
- permission indicators

App actions and mode indicators are detected through duck typing. Each new editor-level application feature creates another propagation obligation.

Target design:

- Define an explicit editor host/adapter contract.
- Keep application-owned actions and state outside replaceable editor implementations where possible.
- Make editor installation apply the complete host contract in one place.
- Avoid probing undocumented fields such as `actionHandlers`.
- Test with a minimal editor implementation, not only `CustomEditor` subclasses.

### Add custom editor disposal

File: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Current problem:

Replacing or restoring a custom editor removes it from the component tree without disposing it. Timers, subscriptions, and terminal resources may survive until process shutdown.

Target design:

- Add an explicit editor lifecycle contract with `dispose()`.
- Centralize editor replacement.
- Dispose each outgoing non-default editor exactly once.
- Cover replacement, restoration, extension reload, session replacement, and shutdown in tests.

## Priority 2: Permission-filtered tools

### Separate desired tools from effective tools

File: `packages/coding-agent/src/core/agent-session.ts`

Current problem:

Read-only mode snapshots active tools, replaces them with read-only tools, and later restores the snapshot. Tool changes made while read-only is active can be lost when the stale snapshot is restored.

Example:

1. Enter read-only mode.
2. An extension changes the desired active tools.
3. Leave read-only mode.
4. The pre-read-only snapshot overwrites the extension's changes.

Target design:

- Keep one canonical desired-tool selection.
- Derive effective tools from desired tools plus permission policy.
- Do not mutate or snapshot the desired selection when changing permission modes.

### Make permission setup safely idempotent

File: `packages/coding-agent/src/core/agent-session.ts`

Current problem:

`enablePermissions()` replaces the permission controller and resets controller state. Rebinding UI handlers can reset rejection/escalation state or interact incorrectly with read-only tool snapshots.

Target design:

- Construct the controller once where possible.
- Update mode and approval handlers without discarding controller state.
- Add a test for repeated binding during an active permission escalation.

## Priority 3: VoxType lifecycle

### Give the backend authoritative recording ownership

Files:

- `packages/coding-agent/examples/extensions/voxtype-push-to-talk/backend.ts`
- `packages/coding-agent/examples/extensions/voxtype-push-to-talk/controller.ts`

Current problem:

If cancellation fails, the backend retains the lock and temporary resources while the controller can return to idle. A later recording attempt then fails against the same process's stale ownership lock.

Target design:

- Make the backend the authoritative recording state machine.
- Represent "external recording may still be active" explicitly.
- Do not encode uncertain external state through leaked local resources.
- Reconcile daemon state before allowing another recording.
- Separate temporary transcript cleanup from external recording ownership.

### Preserve input ordering while transcription completes

Files:

- `packages/coding-agent/examples/extensions/voxtype-push-to-talk/controller.ts`
- `packages/coding-agent/examples/extensions/voxtype-push-to-talk/index.ts`

Current problem:

When another key arrives during recording, transcription starts asynchronously but the key is immediately sent to the editor. The transcript arrives later at a potentially different cursor position.

Target design:

- Queue input that stops recording and replay it after transcription, or
- introduce an asynchronous input-preprocessing contract.
- Add tests for text entry, cursor movement, submit, and cancellation while transcribing.

### Consolidate VoxType setup and teardown

File: `packages/coding-agent/examples/extensions/voxtype-push-to-talk/index.ts`

Current problem:

The controller, editor, keybindings, and raw terminal subscription are stored and cleaned up separately. Asynchronous probing can overlap shutdown or another session start.

Target design:

- Create one session-scoped disposable object.
- Mark it cancelled before teardown.
- Check cancellation after every setup `await`.
- Dispose the editor, terminal subscription, controller, and backend through one path.

## Priority 4: Atomic installation

### Install the fork atomically

File: `scripts/install-fork.sh`

Current problem:

The installer removes the current installation before copying and validating the replacement. A failed copy, symlink operation, or validation can leave Pi absent or partially installed.

Target design:

- Build and validate in a sibling staged directory.
- Atomically rename/swap the staged installation into place.
- Retain the previous installation until the swap succeeds.
- Roll back if binary or extension activation fails.

### Decouple optional VoxType installation

File: `scripts/install-fork.sh`

Current problem:

The extension is described as optional but is always installed. An unrelated existing extension path can block the entire core installation.

Target design:

- Add explicit install/disable/uninstall handling for VoxType.
- Keep core fork installation independent from extension conflicts.

## Priority 5: Runtime state across session boundaries

### Build detached forks from current runtime state

Files:

- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Current problem:

Detached Zellij forks reuse selected startup arguments. Runtime model, provider, thinking-level, or permission changes may not be reflected in the child process.

Target design:

- Capture current runtime state when creating the fork.
- Serialize runtime-affecting configuration through one canonical API.
- Avoid maintaining a manual list of startup flags to forward.

### Define routing-profile persistence explicitly

Files:

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`

Current problem:

Provider switching retains a routing profile, but new, resume, and fork operations create a new session and discard it. Permission mode follows a different persistence model.

Target design:

- Define which runtime preferences survive each session transition.
- Store persistent runtime preferences in a runtime-level owner.
- Reconcile active profiles when settings remove or rename a profile.
- Test new, resume, in-process fork, detached fork, and provider changes.

### Clarify detached-fork lifecycle events

File: `packages/coding-agent/src/core/agent-session-runtime.ts`

Current problem:

Detached forks emit `session_before_fork`, although the parent runtime remains active. Extensions cannot distinguish this from a replacing fork and may prepare for invalidation that never occurs.

Target design:

- Add a detached discriminator or dedicated lifecycle event.
- Document whether parent and child extension instances receive start/shutdown events.

## Priority 6: Terminal capability ownership

### Store keyboard capabilities per terminal instance

Files:

- `packages/tui/src/keys.ts`
- `packages/tui/src/terminal.ts`

Current problem:

Kitty protocol and key-release support are process-global. The most recently negotiated terminal controls all TUI instances, and stopping one terminal can reset state used by another.

Target design:

- Store negotiated capabilities on `Terminal` or `TUI` instances.
- Expose capability queries through `ExtensionUIContext`.
- Pass parser/terminal state explicitly where key interpretation depends on it.
- Add a two-terminal regression test.

## Priority 7: Child-process cleanup

### Remove completed subagent abort listeners

File: `packages/coding-agent/examples/extensions/subagent/index.ts`

Current problem:

Each child process registers an abort listener but does not remove it when the child exits. Completed tasks remain captured until the parent signal aborts, which can also schedule redundant kill timers.

Target design:

- Give each child process one resource scope.
- Remove its abort listener on close or error.
- Clear escalation timers from the same finalizer.
- Make finalization idempotent.

## Testing direction

Prefer lifecycle-level behavioral tests over private-method tests and fabricated partial objects. Important scenarios include:

- custom editor install, replacement, restoration, and disposal
- permission changes initiated through every public path
- session new/resume/fork with current runtime preferences
- active-tool changes while read-only mode is enabled
- VoxType setup/shutdown overlap and failed cancellation
- input arriving while VoxType transcription is pending
- two simultaneous terminal instances with different capabilities
- completed subagents followed by a later parent abort
- installer failure before and during the atomic swap
