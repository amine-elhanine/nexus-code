async function run() {
  const res = await fetch("https://docs.langchain.com/");
  const html = await res.text();
  const re = /<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>/gi;
  let m;
  const allHref = [];
  while ((m = re.exec(html))) {
    allHref.push(m[1]);
  }
  console.log("Total a tags:", allHref.length);
  console.log("Sample hrefs:", allHref.slice(0, 30));
  
  // Also check if links are outside docs.langchain.com
  const sameHost = allHref.filter(h => {
    try {
      const u = new URL(h, "https://docs.langchain.com/");
      return u.host === "docs.langchain.com";
    } catch {
      return false;
    }
  });
  console.log("Same host hrefs:", sameHost);
  
  // What other hosts appear?
  const otherHosts = new Set();
  allHref.forEach(h => {
    try {
      const u = new URL(h, "https://docs.langchain.com/");
      if (u.host !== "docs.langchain.com") otherHosts.add(u.host);
    } catch {}
  });
  console.log("Other hosts linked:", Array.from(otherHosts));
}
run();
