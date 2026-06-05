import React from 'react';
import ReactDOM from 'react-dom/client';
import { StudioApp } from './StudioApp';
import { isLegacyStudioEnabled } from '../services/studioFlags';
import '../index.css';

const root = document.getElementById('studio-root');
if (!root) throw new Error('Studio root element not found');

// The standalone WebContainer studio is the legacy in-browser engine. Code Studio
// consolidates on the live cloud-container path (Sprint 0, S0.2 / decision D2), so this
// page is quarantined behind a dead flag rather than deleted. Without it, show a redirect
// notice instead of booting the retired runtime.
if (isLegacyStudioEnabled()) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <StudioApp />
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: '0.75rem', textAlign: 'center', padding: '2rem',
        fontFamily: 'Inter, system-ui, sans-serif', background: '#0b0e14', color: '#e2e8f0',
      }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800 }}>This studio has moved</h1>
        <p style={{ color: '#94a3b8', maxWidth: '28rem' }}>
          The in-browser WebContainer preview has been retired. Build and run apps in the new
          Code Studio workspace inside the main app.
        </p>
        <a href="/" style={{
          marginTop: '0.5rem', fontWeight: 700, color: '#0b0e14', background: '#38bdf8',
          padding: '0.5rem 1rem', borderRadius: '9999px', textDecoration: 'none',
        }}>
          Go to the app →
        </a>
      </div>
    </React.StrictMode>
  );
}
