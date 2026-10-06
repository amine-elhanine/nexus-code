// Unit tests for the notebook SSRF fetch guard (plain Node, injected DNS
// resolver — no network access, no Electron).
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isPublicHttpUrl } from "../dist-electron/net-guard.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    failed++;
  }
}

console.log("\n=== Notebook Net Guard Tests ===");

// Public and blocked resolvers: the guard must decide based on what the
// HOSTNAME resolves to, not just the literal in the URL.
const resolvesPublic = async () => [{ address: "93.184.216.34", family: 4 }];
const resolvesPrivate = async () => [{ address: "10.1.2.3", family: 4 }];
const resolvesMixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.9", family: 4 }];
const resolvesFail = async () => { throw new Error("getaddrinfo ENOTFOUND"); };

await test("accepts public http(s) URLs", async () => {
  const url = await assertPublicHttpUrl("https://example.com/course-materials", resolvesPublic);
  assert.equal(url.hostname, "example.com");
  assert.ok(await isPublicHttpUrl("http://example.com/page", resolvesPublic));
});

await test("rejects non-http protocols", async () => {
  await assert.rejects(() => assertPublicHttpUrl("ftp://example.com/file", resolvesPublic), /http\(s\)/);
  await assert.rejects(() => assertPublicHttpUrl("file:///C:/Windows", resolvesPublic), /http\(s\)/);
});

await test("rejects invalid URLs", async () => {
  await assert.rejects(() => assertPublicHttpUrl("not a url at all", resolvesPublic), /valid URL/);
});

await test("rejects localhost and intranet-looking hostnames", async () => {
  for (const raw of ["http://localhost/", "http://sub.localhost/", "http://myserver.local/", "http://host.internal/", "http://router.home.arpa/"]) {
    await assert.rejects(() => assertPublicHttpUrl(raw, resolvesPublic), /local or private/);
  }
});

await test("rejects private IPv4 literals", async () => {
  const blocked = [
    "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.1.10/",
    "http://172.16.0.1/", "http://172.31.255.1/", "http://169.254.169.254/",
    "http://0.0.0.0/", "http://100.64.1.1/", "http://198.18.0.1/",
    "http://224.0.0.1/", "http://240.0.0.1/",
  ];
  for (const raw of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(raw, resolvesPublic), /local or private/);
  }
  // Boundary sanity: public neighbors of private ranges pass.
  await assertPublicHttpUrl("http://172.32.0.1/", resolvesPublic);
  await assertPublicHttpUrl("http://100.128.0.1/", resolvesPublic);
  await assertPublicHttpUrl("http://198.20.0.1/", resolvesPublic);
});

await test("rejects private/reserved IPv6 literals", async () => {
  const blocked = ["http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd12::1]/", "http://[fe80::1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:192.168.0.1]/"];
  for (const raw of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(raw, resolvesPublic), /local or private/);
  }
  await assertPublicHttpUrl("http://[2001:4860:4860::8888]/", resolvesPublic);
});

await test("rejects hostnames that resolve to a private address", async () => {
  await assert.rejects(() => assertPublicHttpUrl("https://evil.example.com/", resolvesPrivate), /resolves to a local or private/);
});

await test("rejects hostnames where ANY resolved address is private", async () => {
  await assert.rejects(() => assertPublicHttpUrl("https://rebind.example.com/", resolvesMixed), /resolves to a local or private/);
});

await test("rejects unresolvable hostnames with a friendly error", async () => {
  await assert.rejects(() => assertPublicHttpUrl("https://nope.example.com/", resolvesFail), /Could not resolve/);
});

await test("isPublicHttpUrl returns false instead of throwing", async () => {
  assert.equal(await isPublicHttpUrl("http://localhost/", resolvesPublic), false);
  assert.equal(await isPublicHttpUrl("https://ok.example.com/", resolvesPublic), true);
});

process.exit(failed ? 1 : 0);
