import React, { useEffect, useRef, useState } from 'react';
import { GripHorizontal } from 'lucide-react';

interface DraggablePanelProps {
    storageKey: string;
    defaultSize: { width: number; height: number };
    defaultPosition?: { x: number; y: number };
    minSize?: { width: number; height: number };
    maxSize?: { width: number; height: number };
    className?: string;
    children: React.ReactNode;
    headerBar?: React.ReactNode;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export const DraggablePanel: React.FC<DraggablePanelProps> = ({
    storageKey,
    defaultSize,
    defaultPosition,
    minSize = { width: 300, height: 300 },
    maxSize,
    className = '',
    children,
    headerBar
}) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState(() => {
        if (typeof window === 'undefined') return { ...defaultSize, x: 20, y: 20 };
        try {
            const stored = window.localStorage.getItem(storageKey);
            if (stored) {
                const parsed = JSON.parse(stored);
                return {
                    width: parsed.width || defaultSize.width,
                    height: parsed.height || defaultSize.height,
                    x: parsed.x ?? (defaultPosition?.x || 20),
                    y: parsed.y ?? (defaultPosition?.y || window.innerHeight - defaultSize.height - 20)
                };
            }
        } catch { }
        return {
            ...defaultSize,
            x: defaultPosition?.x || 20,
            y: defaultPosition?.y || (typeof window !== 'undefined' ? window.innerHeight - defaultSize.height - 20 : 20)
        };
    });

    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            window.localStorage.setItem(storageKey, JSON.stringify(state));
        } catch { }
    }, [state, storageKey]);

    // Drag Logic
    const startDrag = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).tagName === 'BUTTON') return; // Don't drag if clicking buttons
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const initialX = state.x;
        const initialY = state.y;

        const onMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            setState(prev => ({
                ...prev,
                x: initialX + dx,
                y: initialY + dy
            }));
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    // Resize Logic
    const startResize = (direction: string) => (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = state.width;
        const startHeight = state.height;
        const startLeft = state.x;
        const startTop = state.y;

        const onMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;

            let nextWidth = startWidth;
            let nextHeight = startHeight;
            let nextX = startLeft;
            let nextY = startTop;

            // Calculate new dims and pos
            if (direction.includes('e')) nextWidth = startWidth + dx;
            if (direction.includes('s')) nextHeight = startHeight + dy;
            if (direction.includes('w')) {
                nextWidth = startWidth - dx;
                nextX = startLeft + dx;
            }
            if (direction.includes('n')) {
                nextHeight = startHeight - dy;
                nextY = startTop + dy;
            }

            // Constraints
            if (nextWidth < minSize.width) {
                nextX = startLeft + (startWidth - minSize.width); // Correction if dragging left handle limit
                if (!direction.includes('w')) nextX = startLeft; // Reset if not dragging west
                nextWidth = minSize.width;
            }
            if (nextHeight < minSize.height) {
                nextY = startTop + (startHeight - minSize.height);
                if (!direction.includes('n')) nextY = startTop;
                nextHeight = minSize.height;
            }

            setState(prev => ({ ...prev, width: nextWidth, height: nextHeight, x: nextX, y: nextY }));
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <div
            ref={panelRef}
            className={`fixed shadow-2xl ${className}`}
            style={{
                left: state.x,
                top: state.y,
                width: state.width,
                height: state.height,
                touchAction: 'none'
            }}
        >
            {/* Drag Handle Area (Header) */}
            <div onPointerDown={startDrag} className="cursor-move">
                {headerBar}
            </div>

            {children}

            {/* Resize Handles */}
            {[
                { dir: 'n', className: 'top-0 left-2 right-2 h-2 cursor-ns-resize' },
                { dir: 's', className: 'bottom-0 left-2 right-2 h-2 cursor-ns-resize' },
                { dir: 'e', className: 'right-0 top-2 bottom-2 w-2 cursor-ew-resize' },
                { dir: 'w', className: 'left-0 top-2 bottom-2 w-2 cursor-ew-resize' },
                { dir: 'ne', className: 'top-0 right-0 w-4 h-4 cursor-nesw-resize z-50' },
                { dir: 'nw', className: 'top-0 left-0 w-4 h-4 cursor-nwse-resize z-50' },
                { dir: 'se', className: 'bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-50' },
                { dir: 'sw', className: 'bottom-0 left-0 w-4 h-4 cursor-nesw-resize z-50' }
            ].map((handle) => (
                <div
                    key={handle.dir}
                    onPointerDown={startResize(handle.dir)}
                    className={`absolute ${handle.className} hover:bg-brand-yellow/50 transition-colors`}
                />
            ))}
        </div>
    );
};
