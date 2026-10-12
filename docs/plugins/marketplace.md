# Marketplace & management UI

Settings → Marketplace (existing UI, incrementally extended):

- Catalog: installed / available / dev, version + update badge
  (`installedVersion !== version`), publisher/author, modes, capabilities.
- **Executable Extensions panel** (`ExecutablePlugins.tsx`): every strictly
  validated v2 plugin with `entry`, showing id, version, apiVersion, status
  (`discovered/validated/enabled/disabled/failed`), granted permissions,
  active capability ids, UI contributions, and errors. Enable asks for
  explicit approval of the listed permissions (sensitive sets show a confirm
  dialog); Disable removes tools, commands, providers, listeners, grants.
- Uninstall disposes executable state BEFORE deleting files (no orphaned
  registrations).
- Enabled plugins with `ui` contributions show per-view **Open** buttons that
  mount the view in the sandboxed modal host.
- Declarative vs executable vs external (MCP) are visually distinct; nothing
  implies cryptographic verification (none exists — trust = source review +
  permission approval).

## Updates & rollback

Install stages to `*.installing-*`, validates (id match + strict manifest
for executables), moves the old install to `*.backup-*`, swaps, and cleans
up. Any failure restores the backup — tested in `plugin-security.test.mjs`
("interrupted update preserves the last working install").
