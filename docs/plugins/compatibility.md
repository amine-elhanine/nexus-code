# API compatibility policy

- SDK version: `PLUGIN_SDK_VERSION = "1"` (`electron/plugin-api.ts`).
  Supported: `SUPPORTED_API_VERSIONS = ["1"]` (`electron/plugin-manifest.ts`).
- v1 bundles without `entry`/`apiVersion` load on the legacy tolerant path
  forever (backward compatible: existing `plugins/skills|agents|commands|rules`
  and marketplace zips keep working — covered by `test/plugins.test.mjs`).
- Within v1: additive only (new optional fields, new slots, new permissions
  as opt-in). Validators ignore nothing silently: unknown values reject.
- v2 (when needed): new `apiVersion: "2"`, old v1 entries keep loading,
  migration notes published here. No silent re-interpretation of v1 fields.

## Migration notes

- `normalizePluginModes` (legacy, tolerant: drops unknown, `[]` = all) is
  kept for discovery of old bundles. New code MUST use
  `validatePluginManifest` (strict: unknown rejected) + `manifestAppliesToMode`.
- `dispatchHooks` now returns the FIRST denial (was: last outcome). If you
  relied on last-wins, update to the monotonic rule.
- `installMarketplacePlugin` now enforces archive limits + strict manifest
  for executables + rollback. Oversized or mismatched bundles that used to
  install will now fail with an error instead.
