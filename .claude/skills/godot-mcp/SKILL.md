---
name: godot-mcp
description: "Interact with Godot Engine via MCP tools. Use for: reading/creating/modifying scenes, running project, runtime debugging, live tuning, screenshots. Only works in main session (subagents cannot call MCP tools)."
---

# Godot MCP Operations

Access Godot Engine directly through MCP tools. Three operation modes based on prerequisites.

**IMPORTANT:** MCP tools are ONLY available in the main session. Subagents cannot call them. If an agent needs MCP data, the main session calls this skill and passes results to the agent.

## Before ANY operation

1. Determine the operation mode (see table below)
2. Check prerequisites
3. If prerequisites not met — ask user or explain what's needed

## Operation Modes

### Mode 1: Headless (Godot MUST be closed)

Scene and project manipulation without running Godot editor.

**Check:** Ask user "Godot закрыт?" before proceeding.

**Available tools:**
- `read_scene` — parse .tscn as structured JSON
- `read_project_settings` — parse project.godot
- `list_project_files` — list/filter project files
- `create_scene` — create new scene with root node
- `add_node` — add node to scene
- `modify_scene_node` — change node properties
- `remove_scene_node` — remove node from scene
- `attach_script` — attach GDScript to node
- `create_resource` — create .tres resource
- `create_script` — create GDScript from template
- `manage_autoloads` — add/remove autoloads
- `manage_scene_signals` — manage signal connections in .tscn
- `manage_scene_structure` — rename/duplicate/move nodes
- `manage_input_map` — add/remove input actions
- `modify_project_settings` — change project settings
- `export_project` — headless export (HTML5, etc.)
- `save_scene` — save scene changes

### Mode 2: Editor (Godot open, game NOT running)

Project info and file operations while editor is open.

**Available tools:**
- `get_project_info` — project metadata
- `get_godot_version` — installed Godot version
- `get_uid` — get UID for a file
- `launch_editor` — launch Godot editor
- `read_file` — read text file from project
- `list_project_files` — list files

### Mode 3: Runtime (Game running with McpInteractionServer)

Live interaction with running game. Requires the game to be launched (from Godot editor or via `run_project`) with `McpInteractionServer` autoload active (TCP port 9090). NOT available in browser/HTML5 builds.

**Check:** Game must be running natively (not in browser).

**Key tools:**

**Inspection:**
- `game_get_scene_tree` — full scene tree structure
- `game_get_node_info` — detailed node introspection
- `game_get_property` — read any property
- `game_performance` — FPS, memory, draw calls
- `game_get_errors` — errors since last call
- `game_get_logs` — print output since last call
- `game_screenshot` — capture screenshot (base64 PNG)

**Manipulation:**
- `game_set_property` — set any property (live tuning!)
- `game_eval` — execute GDScript at runtime
- `game_call_method` — call method on any node
- `game_spawn_node` — spawn node at runtime
- `game_remove_node` — remove node at runtime
- `game_instantiate_scene` — instantiate packed scene

**Input simulation:**
- `game_click`, `game_key_press`, `game_mouse_move` — simulate player input

**Lifecycle:**
- `run_project` — start the game
- `stop_project` — stop the game
- `game_pause` — pause/unpause

## Common Workflows

### Read scene structure
```
1. /godot-mcp
2. Use read_scene with scene path
3. Returns structured JSON of all nodes, properties, signals
```

### Create new component scene
```
1. Ask "Godot закрыт?"
2. create_scene with root node type
3. add_node for child nodes
4. attach_script to root
5. save_scene
```

### Live physics tuning
```
1. Game must be running from Godot editor
2. game_set_property to change physics values
3. game_get_property to verify
4. game_performance to check impact
```

### Debug runtime issue
```
1. Game running
2. game_get_errors — check for errors
3. game_get_scene_tree — verify node structure
4. game_get_property — inspect state
5. game_screenshot — capture visual state
```

## Fallback

If MCP server is not connected or returns errors:
- For scene reading: use `Read` tool on `.tscn` files directly (raw text, not structured JSON)
- For project info: read `project.godot` directly
- For runtime: ask user to check Godot console output manually
