// Secret-storage policy (Phase 1B.2): no silent plaintext fallback.
//
// When the OS credential store (safeStorage) is available, secrets must be
// encrypted at rest. When it is unavailable, persistence is REFUSED: the key
// lives in memory for the session, is written to disk as empty, and the
// provider record is flagged keyNeedsReentry with the "vault-unavailable"
// reason. Cross-machine ciphertext (undecryptable) is preserved, never
// overwritten, and flagged for re-entry. All storage hits are checked against
// the raw state file, not the in-memory view.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Distinct module instance per scenario (fresh in-memory cache + APPDATA).
let moduleEpoch = 0;
const importStore = async () => {
  moduleEpoch += 1;
  return import(`../dist-electron/store.js?s=${moduleEpoch}`);
};

const fakeVaultStore = (store) => ({
  safeStorage: {
    isEncryptionAvailable: () => store,
    encryptString: (value) => Buffer.from(`enc:${value}`),
    // Behaves like the real API: throws on ciphertext produced elsewhere.
    decryptString: (buffer) => {
      const text = buffer.toString();
      if (!text.startsWith("enc:")) throw new Error("decrypt failed");
      return text.slice(4);
    },
  },
});

const readDiskProviders = async (scratch) => {
  const stateFile = path.join(scratch, "nexus", "nexus-state.json");
  const raw = await fs.readFile(stateFile, "utf8");
  assert.ok(!raw.includes("sk-secret"), "a raw key must never be written to the state file");
  return JSON.parse(raw);
};

test("secret policy: with an OS vault, plaintext keys are transparently encrypted on persist", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-vault-ok-"));
  process.env.APPDATA = scratch;
  try {
    const storeMod = await importStore();
    storeMod.setElectronShimForTesting(fakeVaultStore(true));
    const created = await storeMod.createProviderConnection({ provider: "openai", label: "Encrypted Store", apiKey: "sk-secret", baseUrl: "" });
    const onDisk = await readDiskProviders(scratch);
    assert.ok(onDisk.providers[0].apiKey.startsWith("safeStorage:v1:"), "key must be encrypted at rest");
    assert.equal(created.apiKey, "sk-secret", "in-memory key stays usable after persist");
    storeMod.setElectronShimForTesting(null);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("secret policy: without an OS vault, new keys are refused on disk and flagged re-entry", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-vault-missing-"));
  process.env.APPDATA = scratch;
  try {
    const storeMod = await importStore();
    storeMod.setElectronShimForTesting(fakeVaultStore(false));
    const created = await storeMod.createProviderConnection({ provider: "openai", label: "Vault-less", apiKey: "sk-secret", baseUrl: "" });
    assert.equal(created.apiKey, "sk-secret", "key must remain usable in memory for the session");
    const onDisk = await readDiskProviders(scratch);
    assert.equal(onDisk.providers[0].apiKey, "", "refused persistence writes no plaintext");
    const list = await storeMod.listProviders();
    assert.equal(list[0].apiKey, "sk-secret", "cache still serves the key");
    storeMod.setElectronShimForTesting(null);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("secret policy: without an OS vault, cross-machine ciphertext is preserved and flagged", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-vault-missing-"));
  process.env.APPDATA = scratch;
  try {
    const stateDir = path.join(scratch, "nexus");
    await fs.mkdir(stateDir, { recursive: true });
    const ciphertext = "safeStorage:v1:b3JpZ2luYWwtY2lwaGVydGV4dA==";
    await fs.writeFile(path.join(stateDir, "nexus-state.json"), JSON.stringify({
      projects: [],
      providers: [{ id: "prov1", label: "Synced", provider: "openai", apiKey: ciphertext, baseUrl: "", models: [] }],
      embeddingProviders: [],
      homeSessions: [],
    }));

    const storeMod = await importStore();
    storeMod.setElectronShimForTesting(fakeVaultStore(false));
    const list = await storeMod.listProviders();
    assert.equal(list[0].apiKey, "", "ciphertext is unreadable without a vault");
    assert.equal(list[0].keyNeedsReentry, true, "record is flagged for re-entry");
    assert.equal(list[0].keyNeedsReentryReason, "vault-unavailable", "reason names the missing vault");

    // A persist on this machine must not destroy the ciphertext.
    await storeMod.setProviderEnabled("prov1", false);
    const onDisk = await readDiskProviders(scratch);
    assert.equal(onDisk.providers[0].apiKey, ciphertext, "ciphertext survives refuses-and-persist on a vault-less machine");
    assert.equal(onDisk.providers[0].keyNeedsReentry, undefined, "re-entry flag stays in-memory only");
    storeMod.setElectronShimForTesting(null);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("secret policy: undecryptable ciphertext is preserved, flagged cross-machine, and cleared on re-entry", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-vault-fail-"));
  process.env.APPDATA = scratch;
  try {
    const stateDir = path.join(scratch, "nexus");
    await fs.mkdir(stateDir, { recursive: true });
    const ciphertext = "safeStorage:v1:bm90LXJlYWwtY2lwaGVydGV4dA==";
    await fs.writeFile(path.join(stateDir, "nexus-state.json"), JSON.stringify({
      projects: [],
      providers: [{ id: "prov1", label: "Other Machine", provider: "openai", apiKey: ciphertext, baseUrl: "", models: [] }],
      embeddingProviders: [],
      homeSessions: [],
    }));

    const storeMod = await importStore();
    storeMod.setElectronShimForTesting(fakeVaultStore(true));
    const list = await storeMod.listProviders();
    assert.equal(list[0].apiKey, "");
    assert.equal(list[0].keyNeedsReentry, true);
    assert.equal(list[0].keyNeedsReentryReason, "cross-machine");

    // Persist something else — ciphertext not destroyed...
    await storeMod.setProviderEnabled("prov1", false);
    let onDisk = await readDiskProviders(scratch);
    assert.equal(onDisk.providers[0].apiKey, ciphertext, "ciphertext survives a persist on a foreign machine");

    // Re-enter: flag clears and the new key is encrypted for THIS machine.
    await storeMod.updateProviderKey("prov1", "sk-new-key");
    assert.equal((await storeMod.listProviders())[0].keyNeedsReentry, undefined, "re-entry clears the flag");
    assert.equal((await storeMod.listProviders())[0].keyNeedsReentryReason, undefined);
    onDisk = await readDiskProviders(scratch);
    assert.ok(onDisk.providers[0].apiKey.startsWith("safeStorage:v1:"), "re-entered key is encrypted at rest");
    assert.ok(!JSON.stringify(onDisk).includes("sk-new-key"), "re-entered key never lands as plaintext");
    storeMod.setElectronShimForTesting(null);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
