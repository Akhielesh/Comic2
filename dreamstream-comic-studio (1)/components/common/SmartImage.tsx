import React, { useMemo, useState, useEffect } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';

interface SmartImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
    fallbackSrc?: string;
    fallbackSources?: string[];
    fallbackIcon?: React.ReactNode;
    loadingComponent?: React.ReactNode;
    containerClassName?: string;
}

export const SmartImage: React.FC<SmartImageProps> = ({
    src,
    alt,
    className,
    fallbackSrc,
    fallbackSources,
    fallbackIcon,
    loadingComponent,
    containerClassName,
    ...props
}) => {
    const sourceCandidates = useMemo(() => {
        const unique = new Set<string>();
        if (typeof src === 'string' && src.trim()) unique.add(src);
        if (fallbackSrc?.trim()) unique.add(fallbackSrc);
        for (const candidate of fallbackSources || []) {
            if (candidate?.trim()) unique.add(candidate);
        }
        return Array.from(unique);
    }, [src, fallbackSrc, fallbackSources]);

    const [activeSrcIndex, setActiveSrcIndex] = useState(0);
    const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

    useEffect(() => {
        setActiveSrcIndex(0);
        if (sourceCandidates.length === 0) {
            setStatus('error');
            return;
        }
        setStatus('loading');
    }, [sourceCandidates]);

    useEffect(() => {
        if (sourceCandidates.length === 0) {
            setStatus('error');
            return;
        }
        const img = new Image();
        img.src = sourceCandidates[activeSrcIndex];
        img.onload = () => setStatus('loaded');
        img.onerror = () => {
            if (activeSrcIndex < sourceCandidates.length - 1) {
                setActiveSrcIndex((prev) => prev + 1);
                return;
            }
            setStatus('error');
        };
    }, [sourceCandidates, activeSrcIndex]);

    if (status === 'error') {
        return (
            <div className={`flex items-center justify-center bg-gray-100 text-gray-400 ${className} ${containerClassName}`}>
                {fallbackIcon || <ImageOff className="w-8 h-8 opacity-50" />}
            </div>
        );
    }

    if (status === 'loading') {
        return (
            <div className={`flex items-center justify-center bg-gray-100 ${className} ${containerClassName}`}>
                {loadingComponent || <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
            </div>
        );
    }

    return <img src={sourceCandidates[activeSrcIndex]} alt={alt} className={className} {...props} />;
};
