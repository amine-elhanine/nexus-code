(async () => {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
  try {
    const page = await fetch("https://duckduckgo.com/?q=" + encodeURIComponent("Morocco news") + "&iax=images&ia=images", { headers: { "User-Agent": UA } });
    console.log("page HTTP", page.status);
    const html = await page.text();
    const token = html.match(/(?:vqd\s*=\s*['"]|"vqd"\s*:\s*")([^'"\\]+)/i);
    console.log("vqd token:", token ? token[1] : "NOT FOUND");
    if (token) {
      const params = new URLSearchParams({ l: "us-en", o: "json", q: "Morocco news", vqd: token[1], f: "", p: "1" });
      const r = await fetch("https://duckduckgo.com/i.js?" + params, { headers: { "User-Agent": UA, Referer: "https://duckduckgo.com/" } });
      console.log("i.js HTTP", r.status);
      const body = await r.text();
      console.log("body head:", body.slice(0, 200));
    }
  } catch (e) {
    console.error("IMG ERROR", e.message, e.cause && (e.cause.code || e.cause.message));
  }
})();
