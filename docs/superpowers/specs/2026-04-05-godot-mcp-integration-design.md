# Godot MCP Integration Design

**Date**: 2026-04-05
**Status**: Approved
**Approach**: C (skill-based, main session only)

## Problem

Godot MCP server (tugcantopaloglu/godot-mcp, 149 tools) enables direct interaction with Godot Engine. But subagents cannot access MCP tools (verified). All MCP operations must go through the main session.

## Solution

**All MCP operations through main session via skill `/godot-mcp`.**

Subagents and other skills can REQUEST MCP operations by describing what they need — the main session (Claude-PM) executes via the skill.

### Skill `/godot-mcp`

Workflow-based access to Godot MCP tools. Three operation modes:

| Mode | Prerequisites | Example tools |
|------|--------------|---------------|
| **Headless** (Godot closed) | MCP server running | `read_scene`, `create_scene`, `add_node`, `modify_scene_node`, `manage_autoloads` |
| **Editor** (Godot open) | MCP server + Godot editor | `launch_editor`, `get_project_info`, `list_project_files` |
| **Runtime** (Game running) | MCP server + game with McpInteractionServer | `game_eval`, `game_set_property`, `game_performance`, `game_screenshot` |

### What changes

| Action | File |
|--------|------|
| Create | `.claude/skills/godot-mcp/SKILL.md` |
| Update | `CLAUDE.md` — MCP section |
| Update | `docs/superpowers/specs/` — this file |

### What does NOT change

- No agent definitions modified (subagents can't use MCP)
- No existing skills modified
- Agents describe what they need → main session executes MCP

### Installation (already done)

1. tugcantopaloglu/godot-mcp cloned to `C:\tools\godot-mcp`, built
2. `.mcp.json` points to `build/index.js`
3. `mcp_interaction_server.gd` in project as Autoload (skips web builds)
4. Old `addons/godot_mcp/` deleted
