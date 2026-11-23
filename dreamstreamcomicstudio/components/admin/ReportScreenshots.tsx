import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { ownerBearer } from '../../services/accountProviderUsage';
import { buildApiUrl } from '../../services/clientConfig';
import { Button } from '../ds';

export function ReportScreenshots({ id, count }: { id: string; count: number }) {
  const owner = useAuth().user?.id;
  const [position, setPosition] = useState(0);
  const [result, setResult] = useState<{ owner: string; position: number; url?: string; failed?: boolean } | null>(
    null
  );
  useEffect(() => {
    if (!owner || !position) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        const authorization = await ownerBearer(owner, controller.signal);
        const response = await fetch(
          buildApiUrl('/api/admin/analytics/feedback/' + encodeURIComponent(id) + '/screenshots/' + position),
          {
            headers: { Authorization: authorization },
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal
          }
        );
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/webp')) throw new Error();
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setResult({ owner, position, url });
      } catch {
        if (!controller.signal.aborted) setResult({ owner, position, failed: true });
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [owner, id, position]);
  const view = result?.owner === owner && result?.position === position ? result : null;
  return (
    <div className="mt-2 space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-expanded={Boolean(position)}
        onClick={() => {
          setResult(null);
          setPosition((n) => (n ? 0 : 1));
        }}
      >
        {position ? 'Close screenshots' : 'View screenshots (' + count + ')'}
      </Button>
      {position > 0 && (
        <div>
          {view?.url ? (
            <a href={view.url} target="_blank" rel="noreferrer">
              <img
                alt={'Report screenshot ' + position}
                src={view.url}
                className="max-h-72 max-w-full object-contain"
              />
            </a>
          ) : (
            <span role="status">
              {view?.failed ? 'This screenshot could not be loaded. Close and retry.' : 'Loading screenshot…'}
            </span>
          )}
          <div className="flex items-center gap-2 text-xs">
            <Button size="sm" variant="ghost" disabled={position === 1} onClick={() => setPosition((n) => n - 1)}>
              Previous
            </Button>
            {position} of {count}
            <Button
              size="sm"
              variant="ghost"
              disabled={position === count}
              onClick={() => setPosition((n) => n + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
