import React from 'react';

/**
 * The metrics toggle panel — network speed, resolution and every other detail
 * we can honestly measure, in one glanceable card over the video.
 */
export function MetricsOverlay({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="lv-metrics" role="status">
      <h4>{title}</h4>
      {rows.map(([k, v]) => (
        <div className="lv-mrow" key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
