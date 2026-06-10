import React, { useEffect, useState } from 'react';
import { CreateEventView } from './CreateEventView';
import { StudioView } from './StudioView';
import { ViewerView } from './ViewerView';

type Theme = 'dark' | 'light';

const THEME_KEY = 'ds-live-theme';

export function LiveApp() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'));
  useEffect(() => localStorage.setItem(THEME_KEY, theme), [theme]);

  const params = new URLSearchParams(location.search);
  const eventId = params.get('e');
  const hostKey = params.get('k');

  return (
    <div className="live-root" data-theme={theme}>
      <header className="lv-topbar">
        <a href={location.pathname} className="lv-wordmark" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="lv-dot" />
          DreamStream&nbsp;<span className="lv-sub">Live</span>
        </a>
        <span className="lv-spacer" />
        <button className="lv-theme-toggle" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
          {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
        </button>
      </header>
      {!eventId && <CreateEventView />}
      {eventId && hostKey && <StudioView eventId={eventId} hostKey={hostKey} />}
      {eventId && !hostKey && <ViewerView eventId={eventId} />}
    </div>
  );
}
