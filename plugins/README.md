# Nexus Plugin Catalog

This folder is the source of truth for plugins published by the official Nexus Marketplace.
Each plugin is **one installable item** (a skill, agent, command, rule stack, or
hook bundle) inside its capability section:

```
plugins/
  skills/<skill-id>/     manifest.json + skills/<skill-id>/SKILL.md
  agents/<agent-id>/     manifest.json + agents/<agent-id>.md
  commands/<command>/    manifest.json + commands/<command>.md
  rules/<stack>/         manifest.json + rules/<stack>/*.md
  hooks/<hook-id>/       manifest.json + hooks.json
```

The Marketplace lists every item, grouped by these five sections, so users
install exactly the skill / agent / command / rule they want.

## Add a plugin

1. Create one folder in the matching section, e.g. `plugins/skills/my-skill/`,
   with a `manifest.json` (`id`, `name`, `version`) plus the capability
   content in its standard subfolder (`skills/`, `agents/`, …). Optional:
   - `"modes": ["code"]` scopes the whole plugin to agent modes (`home`, `code`, `notebook`); omit or use `[]` for all modes.
   - `"capabilities": ["skills"]` (auto-detected if omitted).
2. Push — that's it. The `Plugins Registry` workflow zips every plugin folder,
   attaches the zips to the rolling `plugins-latest` release, and regenerates
   the root `registry.json` automatically. No manual registry edit needed.

Example registry entry (auto-generated, shown for reference):

```json
{
  "id": "release-notes",
  "name": "Release Notes",
  "version": "1.0.0",
  "author": "Nexus",
  "description": "Generate release notes from Git history.",
  "capabilities": ["skills", "agents", "commands", "rules", "hooks"],
  "modes": ["code"],
  "source": "https://github.com/amine-elhanine/nexus-code/releases/download/plugins-latest/release-notes.zip"
}
```

Nexus automatically loads the raw `registry.json` from this repository for every new install. Users can then click **Install** in Settings → Marketplace.

## Local development (no publishing)

To test your own plugins without touching this repo: Settings → Marketplace →
Advanced → link a dev plugins folder. Every subfolder containing a valid
`manifest.json` appears in your Marketplace automatically — add a folder and
it shows up, no per-plugin registration. The Marketplace also groups listings
by capability (Skills / Agents / Commands / Rules / Hooks).
