const { app } = require("electron");
app.whenReady().then(async () => {
  console.log("electron main-process fetch test, node", process.versions.node, "electron", process.versions.electron);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const targets = [
    ["ddg-lite", { url: "https://lite.duckduckgo.com/lite/", method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "q=Morocco+news" }],
    ["ddg-home", { url: "https://duckduckgo.com/?q=Morocco&iax=images&ia=images", headers: { "User-Agent": UA } }],
    ["example", { url: "https://example.com/", method: "GET" }],
  ];
  for (const [name, init] of targets) {
    try {
      const r = await fetch(init.url, { method: init.method || "GET", headers: init.headers, body: init.body });
      const t = await r.text();
      console.log(name, "-> HTTP", r.status, "len", t.length);
    } catch (e) {
      console.log(name, "-> FAILED:", e.message, "| cause:", e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : "none");
      if (e.cause && e.cause.errors) console.log("  aggregate:", JSON.stringify(e.cause.errors.map(x => x.code || x.message)));
    }
  }
  // Also check proxy env visibility
  console.log("HTTPS_PROXY:", process.env.HTTPS_PROXY || process.env.https_proxy || "(unset)");
  console.log("HTTP_PROXY:", process.env.HTTP_PROXY || process.env.http_proxy || "(unset)");
  process.exit(0);
});
