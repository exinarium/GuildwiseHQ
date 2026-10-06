// Sets data-theme before first paint. External on purpose: the server CSP is script-src 'self' (no inline scripts).
// The storage key mirrors BRAND.storagePrefix + '-theme' in src/brand.ts: keep in sync.
(() => {
  var root = document.documentElement;
  var stored = null;
  try {
    stored = localStorage.getItem('guildwise-theme');
  } catch (e) {}
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    root.dataset.theme =
      stored === 'light' || stored === 'dark' ? stored : mq && mq.matches ? 'dark' : 'light';
  }
  apply();
  if (mq && mq.addEventListener && stored !== 'light' && stored !== 'dark')
    mq.addEventListener('change', apply);
})();
