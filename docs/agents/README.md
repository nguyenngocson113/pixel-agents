# Sample agent definitions

Claude Code agent definitions to pair with the office's characters (Characters view → Role tab). They are samples, not loaded from here: copy the ones you want to `~/.claude/agents/` (every project) or to a project's own `.claude/agents/`.

| File              | Role           | Notes                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feature-lead.md` | `feature-lead` | Runs a feature designer → developer → QC through the office's characters with the delegation tools (`mcp__pixel-agents__*`, standalone only; see CLAUDE.md → Delegation), stopping for approval of the spec and of QC's result. Falls back to sub-agents where the tools are missing. |
| `ux-designer.md`  | `ux-designer`  | Reads Figma (never edits it) and writes the spec to `docs/design/<feature>.md` with exported images. Give its character a Figma link (Role tab) or name one in the task.                                                                                                              |

The lead picks characters by role: give one character each of `ux-designer`, a developer role and `qc` (your own definitions) so it has someone for every stage.
