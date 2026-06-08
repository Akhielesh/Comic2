import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { initTelemetry } from './services/telemetry';

import { BrowserRouter } from 'react-router-dom';

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
