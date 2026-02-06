import React, { useEffect, useRef, useState } from 'react';

interface ResizablePanelProps {
  storageKey: string;
  defaultSize: { width: number; height: number };
  minSize?: { width: number; height: number };
  maxSize?: { width: number; height: number };
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export const ResizablePanel: React.FC<ResizablePanelProps> = ({
  storageKey,
  defaultSize,
  minSize = { width: 320, height: 360 },
  maxSize,
  className = '',
  style,
  children
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => {
    if (typeof window === 'undefined') return defaultSize;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (!stored) return defaultSize;
      const parsed = JSON.parse(stored);
      return {
        width: parsed.width || defaultSize.width,
        height: parsed.height || defaultSize.height
      };
    } catch {
      return defaultSize;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(size));
    } catch {
      // ignore
    }
  }, [size, storageKey]);

  useEffect(() => {
    const handleResize = () => {
      const maxWidth = Math.floor(window.innerWidth * 0.9);
      const maxHeight = Math.floor(window.innerHeight * 0.9);
      setSize((prev) => ({
        width: clamp(prev.width, minSize.width, maxSize?.width ?? maxWidth),
        height: clamp(prev.height, minSize.height, maxSize?.height ?? maxHeight)
      }));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [minSize, maxSize]);

  const startResize = (direction: string) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = size.width;
    const startHeight = size.height;

    const maxWidth = Math.floor(window.innerWidth * 0.9);
    const maxHeight = Math.floor(window.innerHeight * 0.9);

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let nextWidth = startWidth;
      let nextHeight = startHeight;

      if (direction.includes('e')) nextWidth = startWidth + dx;
      if (direction.includes('w')) nextWidth = startWidth - dx;
      if (direction.includes('s')) nextHeight = startHeight + dy;
      if (direction.includes('n')) nextHeight = startHeight - dy;

      nextWidth = clamp(nextWidth, minSize.width, maxSize?.width ?? maxWidth);
      nextHeight = clamp(nextHeight, minSize.height, maxSize?.height ?? maxHeight);
      setSize({ width: nextWidth, height: nextHeight });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const maxWidth = typeof window !== 'undefined' ? Math.floor(window.innerWidth * 0.9) : size.width;
  const maxHeight = typeof window !== 'undefined' ? Math.floor(window.innerHeight * 0.9) : size.height;

  return (
    <div
      ref={panelRef}
      className={`relative ${className}`}
      style={{
        width: clamp(size.width, minSize.width, maxSize?.width ?? maxWidth),
        height: clamp(size.height, minSize.height, maxSize?.height ?? maxHeight),
        maxWidth: maxSize?.width ?? '90vw',
        maxHeight: maxSize?.height ?? '90vh',
        minWidth: minSize.width,
        minHeight: minSize.height,
        ...style
      }}
    >
      {children}
      {[
        { dir: 'n', className: 'top-0 left-2 right-2 h-2 cursor-ns-resize' },
        { dir: 's', className: 'bottom-0 left-2 right-2 h-2 cursor-ns-resize' },
        { dir: 'e', className: 'right-0 top-2 bottom-2 w-2 cursor-ew-resize' },
        { dir: 'w', className: 'left-0 top-2 bottom-2 w-2 cursor-ew-resize' },
        { dir: 'ne', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
        { dir: 'nw', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
        { dir: 'se', className: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
        { dir: 'sw', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' }
      ].map((handle) => (
        <div
          key={handle.dir}
          onPointerDown={startResize(handle.dir)}
          className={`absolute ${handle.className} touch-none`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
};
