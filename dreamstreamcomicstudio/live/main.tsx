import React from 'react';
import { createRoot } from 'react-dom/client';
import { LiveApp } from './LiveApp';
import { LIVE_MANIFEST } from './host';
import './styles/tokens.css';
import './styles/app.css';
import './styles/studio.css';
import './styles/screens.css';
import './styles/features.css';
import './styles/calls.css';
import './styles/meeting.css';
import './styles/monitor-video.css';
import './styles/invite.css';

// Stream Studio's own host installs as its own app (start_url '/#/monitor'); the main host keeps
// the manifest existing Home Screen installs were made from.
const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
if (manifest && manifest.getAttribute('href') !== LIVE_MANIFEST) manifest.setAttribute('href', LIVE_MANIFEST);

const el = document.getElementById('live-root');
if (el) createRoot(el).render(<LiveApp />);
