// Granular provider CRUD: the key can only change through updateProviderKey,
// and connection/model edits can never touch it (the whole-record save path
// that lost keys is gone). Runs against a scratch APPDATA.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

test("provider CRUD: key survives every edit path except explicit key update", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-providers-"));
  process.env.APPDATA = scratch;
  const {
    createProviderConnection, updateProviderConnection, updateProviderKey, setProviderEnabled,
    addProviderModels, updateProviderModel, removeProviderModel, listProviders,
  } = await import("../dist-electron/store.js");
  try {
    // Create: connection only, models start empty, enabled by default.
    const created = await createProviderConnection({ provider: "openai", label: "OpenAI", apiKey: "sk-live-123", baseUrl: "https://api.openai.com/v1" });
    assert.equal(created.models.length, 0, "models are added individually after creation");
    assert.equal(created.enabled, true);
    assert.equal(created.apiKey, "sk-live-123");

    // Edit connection (label/baseUrl): key and models untouched.
    const afterMeta = await updateProviderConnection(created.id, { baseUrl: "https://proxy.example.com/v1" });
    assert.equal(afterMeta.apiKey, "sk-live-123", "connection edit must not touch the key");
    assert.equal(afterMeta.baseUrl, "https://proxy.example.com/v1");

    // Model ops: add (dedupe), rename carries endpoint override, remove clears it.
    await addProviderModels(created.id, ["gpt-5.5", "gpt-5.5-mini"]);
    const duped = await addProviderModels(created.id, ["gpt-5.5", " o3 "]);
    assert.deepEqual(duped.models, ["gpt-5.5", "gpt-5.5-mini", "o3"], "models dedupe and trim");

    const withEndpoint = await updateProviderModel(created.id, "o3", { endpoint: "responses" });
    assert.equal(withEndpoint.modelEndpoints?.o3, "responses");
    const renamed = await updateProviderModel(created.id, "o3", { newName: "o4-mini" });
    assert.ok(renamed.models.includes("o4-mini") && !renamed.models.includes("o3"));
    assert.equal(renamed.modelEndpoints?.["o4-mini"], "responses", "endpoint override follows the rename");
    assert.equal(renamed.modelEndpoints?.o3, undefined);

    const afterRemove = await removeProviderModel(created.id, "o4-mini");
    assert.ok(!afterRemove.models.includes("o4-mini"));
    assert.equal(afterRemove.modelEndpoints?.["o4-mini"], undefined, "override cleared with the model");
    assert.equal(afterRemove.apiKey, "sk-live-123", "model ops must not touch the key");

    // Enable/disable.
    const disabled = await setProviderEnabled(created.id, false);
    assert.equal(disabled.enabled, false);
    const enabled = await setProviderEnabled(created.id, true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.apiKey, "sk-live-123");

    // Explicit key replacement — the only path that changes the key.
    const rekeyed = await updateProviderKey(created.id, "sk-rotated-456");
    assert.equal(rekeyed.apiKey, "sk-rotated-456");
    await assert.rejects(() => updateProviderKey(created.id, "  "), "empty key replacement is rejected");

    // Everything persisted to disk.
    const stateFile = path.join(scratch, "nexus", "nexus-state.json");
    const onDisk = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const diskProvider = onDisk.providers.find((p) => p.id === created.id);
    assert.equal(diskProvider.apiKey, "sk-rotated-456");
    assert.deepEqual(diskProvider.models, ["gpt-5.5", "gpt-5.5-mini"]);
    assert.equal(diskProvider.enabled, true);

    const list = await listProviders();
    assert.equal(list.find((p) => p.id === created.id)?.models.length, 2);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
