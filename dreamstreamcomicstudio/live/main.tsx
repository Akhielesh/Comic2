import React from 'react';
import { createRoot } from 'react-dom/client';
import { LiveApp } from './LiveApp';
import './live.css';

const el = document.getElementById('live-root');
if (el) createRoot(el).render(<LiveApp />);
