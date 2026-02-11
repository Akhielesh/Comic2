import React, { useState, useEffect } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';

interface SmartImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
    fallbackSrc?: string;
    fallbackIcon?: React.ReactNode;
    loadingComponent?: React.ReactNode;
    containerClassName?: string;
}

export const SmartImage: React.FC<SmartImageProps> = ({
    src,
    alt,
    className,
    fallbackSrc,
    fallbackIcon,
    loadingComponent,
    containerClassName,
    ...props
}) => {
    const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

    useEffect(() => {
        setStatus('loading');
        if (!src) {
            setStatus('error');
            return;
        }
        const img = new Image();
        img.src = src;
        img.onload = () => setStatus('loaded');
        img.onerror = () => setStatus('error');
    }, [src]);

    if (status === 'error') {
        if (fallbackSrc) {
            return (
                <img
                    src={fallbackSrc}
                    alt={alt || "fallback"}
                    className={className}
                    {...props}
                />
            );
        }
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

    return <img src={src} alt={alt} className={className} {...props} />;
};
