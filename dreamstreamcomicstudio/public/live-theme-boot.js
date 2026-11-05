/* Stream Studio — the stored appearance on <html> before first paint (live.html loads this file in
 * <head>, as a plain blocking script: the page's CSP allows no inline script, and 'self' allows this).
 * Without it the page would paint light, then flip to a stored dark theme once the bundle runs.
 *
 * It mirrors live/theme.ts exactly — the storage key, the legacy key, parseAppearance's defaults and
 * allowed values, and themeColorFor's four colours. live/themeBoot.unit.test.ts runs this file next
 * to theme.ts on the same inputs and fails if they ever disagree; change both together. The accent
 * is never read here: the bundle writes it (without the Atlas skin only), so nothing here can
 * colour the page wrongly. Any failure leaves the page exactly as the HTML says (light). */
(function () {
  'use strict';
  var KEY = 'ds-live-appearance';
  var LEGACY = 'ds-live-theme';
  var el = document.documentElement;
  var theme = 'light';
  var density = 'calm';
  var corners = 'soft';
  try {
    var raw = null;
    var legacy = null;
    try {
      raw = window.localStorage.getItem(KEY);
      legacy = window.localStorage.getItem(LEGACY);
    } catch (e) {
      /* storage blocked (private mode, sandboxed): the defaults */
    }
    var parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    if (legacy && !raw) theme = legacy === 'light' ? 'light' : 'dark';
    if (parsed.theme === 'light' || parsed.theme === 'dark') theme = parsed.theme;
    if (parsed.density === 'calm' || parsed.density === 'pro') density = parsed.density;
    if (parsed.corners === 'soft' || parsed.corners === 'sharp') corners = parsed.corners;
    el.setAttribute('data-theme', theme);
    el.setAttribute('data-density', density);
    el.setAttribute('data-corners', corners);
    var skin = el.getAttribute('data-ds-skin') === 'atlas';
    var color = skin ? (theme === 'dark' ? '#0a0a0a' : '#ffffff') : (theme === 'dark' ? '#211e1a' : '#f4f2ea');
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', color);
  } catch (e) {
    /* never block the page */
  }
})();
