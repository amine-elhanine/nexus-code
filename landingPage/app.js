// Always-latest download wiring for the Nexus landing page.
//
// The buttons never hardcode a version: on load we ask the GitHub Releases
// API for the latest (non-draft, non-prerelease) release of L7A9/nexus and
// point each button at its exact asset URL. If the API is unreachable
// (rate limit, offline), the buttons keep their static fallback hrefs to
// the releases page, so nothing ever dead-ends.

const OWNER = "L7A9";
const REPO = "nexus";
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

function pickAsset(assets, rx) {
  const list = (assets || []).filter((a) => rx.test(a.name || ""));
  // Prefer the largest match (the full installer over stubs, if any).
  list.sort((a, b) => (b.size || 0) - (a.size || 0));
  return list[0] || null;
}

function setVersionLine(text) {
  document.querySelectorAll(".version-text").forEach((el) => {
    el.textContent = text;
  });
}

function setReleaseNotes(body) {
  const el = document.querySelector(".release-notes");
  if (!el || !body) return;
  const text = String(body).trim().split("\n").slice(0, 6).join("\n").slice(0, 500);
  if (text) {
    el.textContent = text;
    el.hidden = false;
  }
}

async function wireDownloads() {
  let release = null;
  try {
    const res = await fetch(LATEST_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
    release = await res.json();
  } catch {
    setVersionLine("Download the latest release from GitHub");
    return;
  }

  const tag = release.tag_name || release.name || "";
  const version = tag.replace(/^v/, "") || "latest";
  const published = release.published_at ? new Date(release.published_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

  const setup = pickAsset(release.assets, /setup.*\.exe$/i);
  const portable = pickAsset(release.assets, /portable.*\.exe$/i);

  // Primary buttons → exact Setup installer asset (what auto-update serves).
  document.querySelectorAll('[data-dl="setup"]').forEach((a) => {
    if (setup) a.href = setup.browser_download_url;
    const label = a.querySelector(".dl-label");
    if (label) label.textContent = setup ? `Download Nexus v${version}` : "Download for Windows";
  });

  // Secondary buttons → Portable asset, or the releases page if absent.
  document.querySelectorAll('[data-dl="portable"]').forEach((a) => {
    if (portable) a.href = portable.browser_download_url;
  });

  setVersionLine(
    setup
      ? `Latest: v${version}${published ? ` · released ${published}` : ""} · ${(setup.size / 1048576).toFixed(0)} MB`
      : `Latest: v${version} — see all files on GitHub`
  );
  setReleaseNotes(release.body);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireDownloads);
} else {
  wireDownloads();
}
