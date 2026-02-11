
import React, { useState } from 'react';
import { supabase } from '../services/supabase';
import { Loader2, ArrowRight } from 'lucide-react';

export const LoginPage: React.FC = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isSignUp, setIsSignUp] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        setMessage(null);

        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({
                    email,
                    password,
                });
                if (error) throw error;
                setMessage("Check your email for the confirmation link!");
            } else {
                const { error } = await supabase.auth.signInWithPassword({
                    email,
                    password,
                });
                if (error) throw error;
            }
        } catch (err: any) {
            setError(err.message || 'Authentication failed');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-brand-blue p-4">
            {/* Logo Area */}
            <div className="flex items-center gap-3 transform -rotate-3 mb-8">
                <div className="w-16 h-16 bg-brand-yellow border-4 border-black rounded-xl flex items-center justify-center text-black font-display text-5xl shadow-comic">D</div>
                <div className="flex flex-col">
                    <span className="font-display text-5xl tracking-tight text-white leading-none" style={{ textShadow: '4px 4px 0px #000' }}>DreamStream</span>
                    <span className="font-comic font-bold text-black text-xl bg-white px-2 leading-none self-start border-2 border-black transform rotate-2">Comic Studio</span>
                </div>
            </div>

            <div className="bg-white p-8 rounded-xl border-4 border-black shadow-comic max-w-md w-full relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-2 bg-brand-red"></div>

                <h2 className="text-3xl font-display text-black mb-2">{isSignUp ? 'Join the Studio' : 'Welcome Back'}</h2>
                <p className="text-slate-600 font-comic mb-6">
                    {isSignUp ? 'Create your account to start making comics.' : 'Sign in to access your projects.'}
                </p>

                {error && (
                    <div className="bg-red-100 border-2 border-red-500 text-red-700 p-3 rounded mb-4 font-bold text-sm">
                        {error}
                    </div>
                )}

                {message && (
                    <div className="bg-green-100 border-2 border-green-500 text-green-700 p-3 rounded mb-4 font-bold text-sm">
                        {message}
                    </div>
                )}

                <form onSubmit={handleAuth} className="space-y-4">
                    <div>
                        <label className="block text-sm font-bold uppercase mb-1">Email</label>
                        <input
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full border-2 border-black rounded px-4 py-3 font-mono focus:outline-none focus:ring-2 focus:ring-brand-yellow focus:border-black transition-all"
                            placeholder="you@comics.com"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold uppercase mb-1">Password</label>
                        <input
                            type="password"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full border-2 border-black rounded px-4 py-3 font-mono focus:outline-none focus:ring-2 focus:ring-brand-yellow focus:border-black transition-all"
                            placeholder="••••••••"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={isLoading}
                        className="w-full bg-black text-white font-display text-xl py-3 rounded hover:bg-zinc-800 transition-transform active:scale-95 flex items-center justify-center gap-2"
                    >
                        {isLoading ? <Loader2 className="animate-spin" /> : (
                            <>
                                {isSignUp ? 'Create Account' : 'Enter Studio'} <ArrowRight size={20} />
                            </>
                        )}
                    </button>
                </form>

                <div className="mt-6 text-center pt-6 border-t-2 border-slate-100">
                    <button
                        onClick={() => {
                            setIsSignUp(!isSignUp);
                            setError(null);
                            setMessage(null);
                        }}
                        className="text-slate-500 hover:text-black font-bold underline decoration-2 underline-offset-2"
                    >
                        {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
                    </button>
                </div>
            </div>

            <div className="mt-8 text-white/50 font-mono text-xs text-center">
                Powered by DreamStream AI &bull; v0.1.0 Beta
            </div>
        </div>
    );
};
