# Nexus Plugin Catalog

This folder is the source of truth for plugins published by the official Nexus Marketplace.

## Add a plugin

1. Create `plugins/<plugin-id>/`.
2. Add a `manifest.json` with at least `id`, `name`, and `version`. Optional:
   - `"modes": ["code"]` scopes the whole plugin to agent modes (`home`, `code`, `notebook`); omit or use `[]` for all modes.
   - `"capabilities": ["skills", "agents", "commands", "rules", "hooks"]` (auto-detected if omitted).
3. Bundle your customizations into the plugin directory:
   - `skills/`: one or more `SKILL.md` skill folders.
   - `agents/`: specialized subagent `.md` files (e.g. `code-architect.md`, `python-reviewer.md`).
   - `commands/`: custom slash command `.md` files (e.g. `code-review.md`, `build-fix.md`).
   - `rules/`: rule files (`.md`, `.rule`, or stack directories like `python/`, `react/`, `common/`).
   - `hooks.json`: optional lifecycle hooks.
4. Package the contents of that plugin folder into `<plugin-id>.zip` and attach it to a GitHub Release in this repository.
5. Add the plugin's metadata and Release ZIP URL to the root `registry.json`.

Example registry entry:

```json
{
  "id": "release-notes",
  "name": "Release Notes",
  "version": "1.0.0",
  "author": "Nexus",
  "description": "Generate release notes from Git history.",
  "capabilities": ["skills", "agents", "commands", "rules", "hooks"],
  "modes": ["code"],
  "source": "https://github.com/amine-elhanine/nexus-code/releases/download/plugins-v1/release-notes.zip"
}
```

Nexus automatically loads the raw `registry.json` from this repository for every new install. Users can then click **Install** in Settings → Marketplace.
