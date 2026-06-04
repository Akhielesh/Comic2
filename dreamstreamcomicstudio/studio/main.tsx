import React from 'react';
import ReactDOM from 'react-dom/client';
import { StudioApp } from './StudioApp';
import '../index.css';

const root = document.getElementById('studio-root');
if (!root) throw new Error('Studio root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <StudioApp />
  </React.StrictMode>
);
