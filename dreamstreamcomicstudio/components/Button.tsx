import React from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  size = 'md',
  isLoading, 
  icon, 
  className = '', 
  disabled,
  ...props 
}) => {
  const sizeStyles = {
    sm: "px-4 py-2 text-xs",
    md: "px-6 py-3 text-lg",
    lg: "px-8 py-4 text-xl"
  };
  const baseStyles = "relative flex items-center justify-center rounded-lg font-comic font-bold uppercase tracking-wide transition-all duration-150 border-2 border-black disabled:opacity-50 disabled:cursor-not-allowed transform";
  
  const variants = {
    primary: "bg-brand-yellow text-black shadow-comic hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none",
    secondary: "bg-white text-black shadow-comic hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none",
    outline: "bg-white border-black text-black shadow-comic hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none",
    danger: "bg-brand-red text-white shadow-comic hover:translate-y-[2px] hover:shadow-comic-hover active:translate-y-[4px] active:shadow-none",
  };

  return (
    <button 
      className={`${baseStyles} ${sizeStyles[size]} ${variants[variant]} ${className}`}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? (
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
      ) : icon ? (
        <span className="mr-2">{icon}</span>
      ) : null}
      {children}
    </button>
  );
};
