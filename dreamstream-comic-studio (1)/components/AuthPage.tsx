import React, { useState } from 'react';
import { supabase } from '../services/supabase';
import { Loader2, ArrowRight, Eye, EyeOff, CheckSquare, Square } from 'lucide-react';

interface AuthPageProps {
    onLoginSuccess: () => void;
    onOpenPrivacy: () => void;
    onOpenTerms: () => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onLoginSuccess, onOpenPrivacy, onOpenTerms }) => {
    const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    // Fields
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [rememberMe, setRememberMe] = useState(true);

    // Consents
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [marketingConsent, setMarketingConsent] = useState(false);

    // Handlers
    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setMessage(null);
        setIsLoading(true);

        try {
            if (mode === 'signup') {
                // Validation
                if (password !== confirmPassword) throw new Error("Passwords do not match.");
                if (!termsAccepted) throw new Error("You must accept the Terms & Conditions.");
                if (username.length < 3) throw new Error("Username must be at least 3 characters.");

                // 1. Sign Up
                const { data, error: signUpError } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: { username } // Pass metadata for verification emails
                    }
                });
                if (signUpError) throw signUpError;
                if (!data.user) throw new Error("Signup failed.");

                // 2. Profile Update (Trigger fallback/ensure)
                const { error: profileError } = await supabase.from('profiles').update({
                    username,
                    terms_accepted: termsAccepted,
                    marketing_consent: marketingConsent
                }).eq('id', data.user.id);

                if (profileError) {
                    // Non-blocking warning, but good to know
                    console.warn("Profile update warning:", profileError);
                }

                setMessage("Account created! Please check your email to confirm.");
                setMode('signin');
            } else if (mode === 'signin') {
                // Sign In
                let signInEmail = email;

                // Simple heuristic: if doesn't contain '@', treat as username lookup
                if (!email.includes('@')) {
                    // Try to find email by username from profiles (Public Read allowed)
                    const { data, error } = await supabase.from('profiles').select('email').eq('username', email).single();
                    if (error || !data || !data.email) {
                        throw new Error("Username not found. Please use your email.");
                    }
                    signInEmail = data.email;
                }

                const { error: signInError } = await supabase.auth.signInWithPassword({
                    email: signInEmail,
                    password,
                });
                if (signInError) throw signInError;

                // Success
                onLoginSuccess();
            } else if (mode === 'forgot') {
                // Forgot Password
                const { error } = await supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: window.location.origin + '?view=reset'
                });
                if (error) throw error;
                setMessage("Password reset link sent! Check your email.");
                setMode('signin');
            }
        } catch (err: any) {
            setError(err.message || "Authentication failed.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-4">
            {/* Brand */}
            <div className="flex items-center gap-3 mb-8 cursor-default">
                <div className="w-12 h-12 bg-brand-yellow border-4 border-black rounded-xl flex items-center justify-center text-black font-display text-3xl shadow-comic transform -rotate-3">D</div>
                <div className="flex flex-col">
                    <span className="font-display text-4xl tracking-tight text-black leading-none">DreamStream</span>
                    <span className="font-comic font-bold text-brand-blue text-sm uppercase tracking-widest leading-none">Studio Access</span>
                </div>
            </div>

            <div className="bg-white rounded-2xl border-4 border-black shadow-comic max-w-md w-full overflow-hidden">
                {/* Tabs */}
                <div className="flex border-b-4 border-black">
                    <button
                        onClick={() => { setMode('signin'); setError(null); }}
                        className={`flex-1 py-4 font-display text-xl transition-colors ${mode === 'signin' ? 'bg-brand-yellow text-black' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
                    >
                        Sign In
                    </button>
                    <button
                        onClick={() => { setMode('signup'); setError(null); }}
                        className={`flex-1 py-4 font-display text-xl transition-colors ${mode === 'signup' ? 'bg-brand-blue text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
                    >
                        Sign Up
                    </button>
                </div>

                <div className="p-8">
                    {/* Header for Forgot Password */}
                    {mode === 'forgot' && (
                        <div className="mb-6 text-center">
                            <h3 className="font-display text-xl mb-1">Reset Password</h3>
                            <p className="text-sm text-slate-500">Enter your email to receive a reset link.</p>
                        </div>
                    )}

                    {error && (
                        <div className="bg-red-50 border-2 border-red-500 text-red-600 p-3 rounded-lg mb-6 text-sm font-bold flex items-start gap-2 animate-shake">
                            <span className="mt-0.5">⚠️</span> {error}
                        </div>
                    )}
                    {message && (
                        <div className="bg-green-50 border-2 border-green-500 text-green-600 p-3 rounded-lg mb-6 text-sm font-bold flex items-start gap-2">
                            <span className="mt-0.5">✅</span> {message}
                        </div>
                    )}

                    <form onSubmit={handleAuth} className="space-y-4">
                        {mode === 'signup' && (
                            <div>
                                <label className="block text-xs font-bold uppercase mb-1">Username</label>
                                <input
                                    type="text"
                                    required
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none"
                                    placeholder="ComicArtist99"
                                />
                            </div>
                        )}

                        <div>
                            <label className="block text-xs font-bold uppercase mb-1">{mode === 'signin' ? 'Email / Username' : 'Email'}</label>
                            <input
                                type="text" // Allow text to support username theoretically, but validation warns.
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none"
                                placeholder={mode === 'signin' ? "user@example.com or username" : "user@example.com"}
                            />
                        </div>

                        {mode !== 'forgot' && (
                            <div className="relative">
                                <label className="block text-xs font-bold uppercase mb-1">Password</label>
                                <input
                                    type={showPassword ? "text" : "password"}
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none pr-10"
                                    placeholder="••••••••"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-8 text-slate-400 hover:text-black"
                                >
                                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                                </button>
                            </div>
                        )}

                        {mode === 'signup' && (
                            <div className="relative">
                                <label className="block text-xs font-bold uppercase mb-1">Confirm Password</label>
                                <input
                                    type={showPassword ? "text" : "password"}
                                    required
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    className={`w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none ${confirmPassword && password !== confirmPassword ? 'border-red-500 bg-red-50' : ''}`}
                                    placeholder="••••••••"
                                />
                            </div>
                        )}

                        {mode === 'signup' && (
                            <div className="space-y-3 pt-2">
                                <label className="flex items-start gap-3 cursor-pointer group">
                                    <div className={`mt-0.5 w-5 h-5 border-2 border-black rounded flex items-center justify-center transition-colors ${termsAccepted ? 'bg-black text-white' : 'bg-white'}`}>
                                        {termsAccepted && <CheckSquare size={14} />}
                                    </div>
                                    <input type="checkbox" className="hidden" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} />
                                    <span className="text-xs text-slate-600 font-bold leading-tight group-hover:text-black">
                                        I accept the <button type="button" onClick={(e) => { e.preventDefault(); onOpenTerms(); }} className="underline">Terms and Conditions</button> and <button type="button" onClick={(e) => { e.preventDefault(); onOpenPrivacy(); }} className="underline">Privacy Policy</button>.
                                    </span>
                                </label>
                                <label className="flex items-start gap-3 cursor-pointer group">
                                    <div className={`mt-0.5 w-5 h-5 border-2 border-black rounded flex items-center justify-center transition-colors ${marketingConsent ? 'bg-brand-yellow text-black' : 'bg-white'}`}>
                                        {marketingConsent && <CheckSquare size={14} />}
                                    </div>
                                    <input type="checkbox" className="hidden" checked={marketingConsent} onChange={(e) => setMarketingConsent(e.target.checked)} />
                                    <span className="text-xs text-slate-600 font-bold leading-tight group-hover:text-black">
                                        (Optional) Send me marketing emails and updates.
                                    </span>
                                </label>
                            </div>
                        )}

                        {mode === 'signin' && (
                            <div className="flex items-center justify-between pt-2">
                                <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-600 hover:text-black">
                                    <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="accent-black" />
                                    Remember me
                                </label>
                                <button type="button" onClick={() => { setMode('forgot'); setError(null); }} className="text-xs font-bold text-slate-400 hover:text-black hover:underline">
                                    Forgot password?
                                </button>
                            </div>
                        )}

                        {mode === 'forgot' && (
                            <button type="button" onClick={() => { setMode('signin'); setError(null); }} className="text-xs font-bold text-slate-500 hover:text-black hover:underline block mx-auto">
                                Back to Sign In
                            </button>
                        )}

                        <button
                            type="submit"
                            disabled={isLoading}
                            className={`w-full py-4 rounded-xl font-display text-xl border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all flex items-center justify-center gap-2 ${mode === 'signup' ? 'bg-brand-blue text-white' : 'bg-brand-yellow text-black'}`}
                        >
                            {isLoading ? <Loader2 className="animate-spin" /> : (
                                <>
                                    {mode === 'signin' ? 'Enter Studio' : mode === 'forgot' ? 'Send Reset Link' : 'Create Account'} <ArrowRight size={20} />
                                </>
                            )}
                        </button>
                    </form>
                </div>
            </div>

            <div className="mt-8 text-center text-xs font-mono text-slate-400">
                &copy; 2026 DreamStream Inc. All rights reserved.
            </div>
        </div>
    );
};
