import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { initTelemetry } from './services/telemetry';
import { bootDsSkin } from './services/dsSkin';
import { initTheme } from './services/theme';

import { BrowserRouter } from 'react-router-dom';

// Design skin first, synchronously, before anything renders: <html> carries `data-ds-skin="atlas"` on
// every host (index.html ships it; the comics host sets it even when the build kill switch stripped it),
// plus the two font preloads (docs/design/atlas-skin.md).
bootDsSkin({ document });
// The saved theme on every page, not only in Chat and Comic Studio (public/theme-boot.js already set
// `.dark` before first paint, so this normally finds it right and changes nothing). Idempotent: the
// shells' own initTheme() calls are no-ops after it.
initTheme();

// Start capturing uncaught errors / unhandled rejections + batch-flush telemetry
// as early as possible, so crashes during initial render are still recorded.
initTelemetry();

const VITE_PRELOAD_RETRY_KEY = 'dreamstream_vite_preload_retry';

window.addEventListener('vite:preloadError', (event) => {
  const hasRetried = sessionStorage.getItem(VITE_PRELOAD_RETRY_KEY) === '1';
  if (hasRetried) return;
  event.preventDefault();
  sessionStorage.setItem(VITE_PRELOAD_RETRY_KEY, '1');
  window.location.reload();
});

window.addEventListener('load', () => {
  sessionStorage.removeItem(VITE_PRELOAD_RETRY_KEY);
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
