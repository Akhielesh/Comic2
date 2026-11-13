/* Theme before first paint (bridge D5; services/theme.ts is the source of the key and the values).
   A classic external script in <head>: the page's CSP allows 'self' scripts and hashes its one inline
   script, so this cannot be inline. It puts `.dark` on <html> when the saved choice is dark, or "system"
   on a dark OS, so a dark page never flashes light while the bundle loads; initTheme() then finds the
   class already right. Every storage and media-query access is guarded: a blocked localStorage (private
   mode, a sandboxed frame) or an old browser leaves the page light, exactly as before. */
(function () {
  var pref = 'light';
  try {
    var saved = window.localStorage.getItem('ds.theme.v1');
    if (saved === 'dark' || saved === 'system') pref = saved;
  } catch (e) {
    pref = 'light';
  }
  try {
    var host = window.location.hostname.toLowerCase().replace(/\.$/, '');
    if (
      (host === 'comics.dreamstreamstudio.ai' || host === 'comic.dreamstreamstudio.ai') &&
      window.localStorage.getItem('ds.comic-theme.v1') === 'paper'
    ) {
      document.documentElement.setAttribute('data-comic-theme', 'paper');
    }
  } catch (e) {
    /* Atlas is the default when storage is unavailable. */
  }
  var dark = pref === 'dark';
  if (pref === 'system') {
    try {
      dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      dark = false;
    }
  }
  try {
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    /* nothing to do: the app applies the theme once it loads */
  }
})();
