import React from 'react';
import { createRoot } from 'react-dom/client';
import { LiveApp } from './LiveApp';
import './styles/tokens.css';
import './styles/app.css';
import './styles/studio.css';
import './styles/screens.css';

const el = document.getElementById('live-root');
if (el) createRoot(el).render(<LiveApp />);
