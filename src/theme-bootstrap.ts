// Applied as a separate module (not inline) so the renderer CSP can stay
// `script-src 'self'`. Module scripts execute in document order, so the
// theme lands before main.tsx renders anything — no wrong-theme flash.
try {
  const theme = localStorage.getItem("nexus-theme");
  if (theme) document.documentElement.dataset.theme = theme;
} catch {
  /* storage unavailable (private mode) — default theme applies */
}
