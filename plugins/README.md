# Nexus Plugin Catalog

This folder is the source of truth for plugins published by the official Nexus Marketplace.

## Add a plugin

1. Create `plugins/<plugin-id>/`.
2. Add a `manifest.json` with at least `id`, `name`, and `version`.
3. Add a `skills/` folder containing one or more `SKILL.md` bundles and optionally `hooks.json`.
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
  "capabilities": ["skills", "hooks"],
  "source": "https://github.com/amine-elhanine/nexus-code/releases/download/plugins-v1/release-notes.zip"
}
```

Nexus automatically loads the raw `registry.json` from this repository for every new install. Users can then click **Install** in Settings → Marketplace.
