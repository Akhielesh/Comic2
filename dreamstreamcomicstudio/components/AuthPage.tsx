import React, { useState } from 'react';
import { getAuthPersistMode, getAuthRedirectUrl, setAuthPersistMode, supabase } from '../services/supabase';
import { Loader2, ArrowRight, Eye, EyeOff, CheckSquare } from 'lucide-react';

interface AuthPageProps {
    onLoginSuccess: () => void;
    onOpenPrivacy: () => void;
    onOpenTerms: () => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onLoginSuccess, onOpenPrivacy, onOpenTerms }) => {
    const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const MIN_SIGNUP_AGE_YEARS = 8;
    const [mode, setMode] = useState<'signin' | 'signup' | 'forgot' | 'magic-link'>('signin');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    // Fields
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [dob, setDob] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [rememberMe, setRememberMe] = useState(getAuthPersistMode() === 'local');
    const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
    const authRedirectUrl = getAuthRedirectUrl();

    // Consents
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [marketingConsent, setMarketingConsent] = useState(false);
    const maxSignupDob = (() => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setFullYear(date.getFullYear() - MIN_SIGNUP_AGE_YEARS);
        return date.toISOString().slice(0, 10);
    })();

    const getDuplicateSignupError = (err: unknown): string | null => {
        const message = String((err as { message?: string } | null)?.message || '').toLowerCase();
        if (
            message.includes('already registered') ||
            message.includes('already exists') ||
            message.includes('user already') ||
            message.includes('email address already')
        ) {
            return 'An account with this email already exists. Please sign in or reset your password.';
        }
        return null;
    };

    const handleResendVerification = async () => {
        const normalizedEmail = (pendingVerificationEmail || email || '').trim().toLowerCase();
        if (!EMAIL_REGEX.test(normalizedEmail)) {
            setError('Enter a valid email address to resend verification.');
            return;
        }

        setError(null);
        setMessage(null);
        setIsLoading(true);
        try {
            const { error: resendError } = await supabase.auth.resend({
                type: 'signup',
                email: normalizedEmail,
                options: {
                    emailRedirectTo: authRedirectUrl
                }
            });
            if (resendError) throw resendError;
            setPendingVerificationEmail(normalizedEmail);
            setMessage('Verification email sent. Check inbox and spam.');
        } catch (err: any) {
            setError(err?.message || 'Failed to resend verification email.');
        } finally {
            setIsLoading(false);
        }
    };

    // Handlers
    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setMessage(null);
        if (mode !== 'signin') setPendingVerificationEmail(null);
        setIsLoading(true);

        try {
            if (mode === 'signup') {
                // Validation
                const normalizedEmail = email.trim().toLowerCase();
                const normalizedUsername = username.trim();
                const normalizedFirstName = firstName.trim();
                const normalizedLastName = lastName.trim();
                const normalizedPhoneNumber = phoneNumber.trim();
                const normalizedDob = dob.trim();

                if (!normalizedEmail) throw new Error("Email is required.");
                if (!EMAIL_REGEX.test(normalizedEmail)) throw new Error("Please enter a valid email.");
                if (!normalizedUsername) throw new Error("Username is required.");
                if (!USERNAME_REGEX.test(normalizedUsername)) {
                    throw new Error("Username must be 3-20 chars and use only letters, numbers, or underscore.");
                }
                if (!normalizedFirstName) throw new Error("First name is required.");
                if (password.length < 8) throw new Error("Password must be at least 8 characters.");
                if (password !== confirmPassword) throw new Error("Passwords do not match.");
                if (!termsAccepted) throw new Error("You must accept the Terms & Conditions.");
                if (!normalizedDob) throw new Error("Date of birth is required.");

                const dobDate = new Date(`${normalizedDob}T00:00:00`);
                if (Number.isNaN(dobDate.getTime())) throw new Error("Date of birth must be valid.");
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                if (dobDate > today) throw new Error("Date of birth cannot be in the future.");
                const minAllowedDob = new Date(today);
                minAllowedDob.setFullYear(today.getFullYear() - MIN_SIGNUP_AGE_YEARS);
                if (dobDate > minAllowedDob) throw new Error(`You must be at least ${MIN_SIGNUP_AGE_YEARS} years old to sign up.`);

                // Fast username availability check before submit.
                const { data: usernameLookupData, error: usernameLookupError } = await supabase.rpc('resolve_email_from_username', { login_username: normalizedUsername });
                if (usernameLookupError) {
                    const usernameLookupMessage = String(usernameLookupError?.message || '').toLowerCase();
                    const missingResolver = usernameLookupMessage.includes('resolve_email_from_username') && usernameLookupMessage.includes('does not exist');
                    if (!missingResolver) throw usernameLookupError;
                    console.warn('Username resolver RPC missing; relying on DB uniqueness enforcement.');
                } else {
                    const existingEmailForUsername = Array.isArray(usernameLookupData)
                        ? usernameLookupData[0]?.email
                        : (usernameLookupData as { email?: string } | null)?.email;
                    if (existingEmailForUsername) {
                        throw new Error("Username is already taken. Please choose another.");
                    }
                }

                // Sign up with metadata. Profile rows are created by Supabase DB trigger.
                const { data, error: signUpError } = await supabase.auth.signUp({
                    email: normalizedEmail,
                    password,
                    options: {
                        emailRedirectTo: authRedirectUrl,
                        data: {
                            username: normalizedUsername,
                            first_name: normalizedFirstName,
                            last_name: normalizedLastName || null,
                            phone_number: normalizedPhoneNumber || null,
                            dob: normalizedDob,
                            terms_accepted: termsAccepted,
                            marketing_consent: marketingConsent,
                            email_pref_product_updates: true,
                            email_pref_marketing: marketingConsent
                        }
                    }
                });
                if (signUpError) {
                    const duplicateMessage = getDuplicateSignupError(signUpError);
                    if (duplicateMessage) throw new Error(duplicateMessage);
                    throw signUpError;
                }
                if (!data.user) throw new Error("Signup failed.");
                if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                    throw new Error("An account with this email already exists. Please sign in or reset your password.");
                }

                setMessage("Account created! Please check your email to confirm.");
                setMode('signin');
                setPassword('');
                setConfirmPassword('');
            } else if (mode === 'signin') {
                // Sign In
                const loginInput = email.trim();
                if (!loginInput) throw new Error("Email or username is required.");
                let signInEmail = loginInput;
                setPendingVerificationEmail(null);
                setAuthPersistMode(rememberMe ? 'local' : 'session');

                // Simple heuristic: if doesn't contain '@', treat as username lookup
                if (!loginInput.includes('@')) {
                    const { data, error } = await supabase.rpc('resolve_email_from_username', { login_username: loginInput });
                    if (error) throw error;

                    const resolvedEmail = Array.isArray(data)
                        ? data[0]?.email
                        : (data as { email?: string } | null)?.email;
                    if (!resolvedEmail) {
                        throw new Error("Username not found. Please use your email.");
                    }
                    signInEmail = resolvedEmail;
                } else {
                    signInEmail = loginInput.toLowerCase();
                }

                const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
                    email: signInEmail,
                    password,
                });
                if (signInError) {
                    const signInMessage = String(signInError.message || '').toLowerCase();
                    if (signInMessage.includes('email not confirmed') || signInMessage.includes('email not verified')) {
                        setPendingVerificationEmail(signInEmail);
                        throw new Error("Verify your email first. Use the resend button below if needed.");
                    }
                    if (signInMessage.includes('invalid login credentials')) {
                        throw new Error("Invalid credentials. If this account is new, verify your email first.");
                    }
                    throw signInError;
                }
                const signedInUser = signInData.user || signInData.session?.user;
                if (!signedInUser?.email_confirmed_at) {
                    await supabase.auth.signOut({ scope: 'local' });
                    setPendingVerificationEmail(signInEmail);
                    throw new Error("Verify your email first. Use the resend button below if needed.");
                }

                // Success
                setPendingVerificationEmail(null);
                onLoginSuccess();
            } else if (mode === 'magic-link') {
                const normalizedEmail = email.trim().toLowerCase();
                if (!EMAIL_REGEX.test(normalizedEmail)) {
                    throw new Error("Enter a valid email to receive a magic link.");
                }
                setAuthPersistMode(rememberMe ? 'local' : 'session');

                const { error } = await supabase.auth.signInWithOtp({
                    email: normalizedEmail,
                    options: {
                        emailRedirectTo: authRedirectUrl
                    }
                });
                if (error) throw error;

                setMessage("Magic link sent! Check your email to continue.");
                setMode('signin');
            } else if (mode === 'forgot') {
                const normalizedEmail = email.trim().toLowerCase();
                if (!EMAIL_REGEX.test(normalizedEmail)) {
                    throw new Error("Enter a valid email for password reset.");
                }
                // Forgot Password
                const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
                    redirectTo: authRedirectUrl
                });
                if (error) throw error;
                setMessage("Password reset link sent! Check your email.");
                setMode('signin');
            }
        } catch (err: any) {
            setError(err?.message || "Authentication failed.");
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
                        onClick={() => { setMode('signin'); setError(null); setMessage(null); setPendingVerificationEmail(null); }}
                        className={`flex-1 py-4 font-display text-xl transition-colors ${(mode === 'signin' || mode === 'forgot' || mode === 'magic-link') ? 'bg-brand-yellow text-black' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
                    >
                        Sign In
                    </button>
                    <button
                        onClick={() => { setMode('signup'); setError(null); setMessage(null); setPendingVerificationEmail(null); }}
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
                    {mode === 'magic-link' && (
                        <div className="mb-6 text-center">
                            <h3 className="font-display text-xl mb-1">Magic Link Sign In</h3>
                            <p className="text-sm text-slate-500">Enter your email and we will send a secure sign-in link.</p>
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
                    {mode === 'signin' && pendingVerificationEmail && (
                        <div className="bg-amber-50 border-2 border-amber-500 text-amber-800 p-3 rounded-lg mb-6 text-sm font-bold">
                            <div className="mb-2">Email not verified for <span className="font-mono">{pendingVerificationEmail}</span>.</div>
                            <button
                                type="button"
                                onClick={handleResendVerification}
                                disabled={isLoading}
                                className="underline disabled:opacity-60"
                            >
                                {isLoading ? 'Sending…' : 'Resend verification email'}
                            </button>
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
                                    placeholder="Super_hero"
                                />
                            </div>
                        )}

                        {mode === 'signup' && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase mb-1">First Name *</label>
                                    <input
                                        type="text"
                                        required
                                        value={firstName}
                                        onChange={(e) => setFirstName(e.target.value)}
                                        className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none"
                                        placeholder="Super"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase mb-1">Last Name (Optional)</label>
                                    <input
                                        type="text"
                                        value={lastName}
                                        onChange={(e) => setLastName(e.target.value)}
                                        className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none"
                                        placeholder="Hero"
                                    />
                                </div>
                            </div>
                        )}

                        <div>
                                <label className="block text-xs font-bold uppercase mb-1">{mode === 'signin' ? 'Email / Username' : 'Email'}</label>
                                <input
                                type={mode === 'signin' ? 'text' : 'email'}
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none"
                                placeholder={mode === 'signin' ? "user@example.com or username" : "user@example.com"}
                            />
                        </div>

                        {mode === 'signup' && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase mb-1">Date of Birth *</label>
                                    <input
                                        type="date"
                                        required
                                        value={dob}
                                        onChange={(e) => setDob(e.target.value)}
                                        max={maxSignupDob}
                                        className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none"
                                    />
                                    <p className="text-[10px] text-slate-500 mt-1">Must be at least {MIN_SIGNUP_AGE_YEARS} years old.</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase mb-1">Phone Number (Optional)</label>
                                    <input
                                        type="tel"
                                        value={phoneNumber}
                                        onChange={(e) => setPhoneNumber(e.target.value)}
                                        className="w-full border-2 border-black rounded-lg px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-brand-blue focus:outline-none"
                                        placeholder="+1 555 123 4567"
                                    />
                                </div>
                            </div>
                        )}

                        {mode !== 'forgot' && mode !== 'magic-link' && (
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

                        {(mode === 'signin' || mode === 'magic-link') && (
                            <div className="flex items-center justify-between pt-2">
                                {mode === 'signin' ? (
                                    <>
                                        <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-600 hover:text-black">
                                            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="accent-black" />
                                            Remember me
                                        </label>
                                        <div className="flex items-center gap-3">
                                            <button type="button" onClick={() => { setMode('magic-link'); setError(null); setMessage(null); setPendingVerificationEmail(null); }} className="text-xs font-bold text-slate-400 hover:text-black hover:underline">
                                                Continue with Magic Link
                                            </button>
                                            <button type="button" onClick={() => { setMode('forgot'); setError(null); setMessage(null); setPendingVerificationEmail(null); }} className="text-xs font-bold text-slate-400 hover:text-black hover:underline">
                                                Forgot password?
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-600 hover:text-black">
                                            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="accent-black" />
                                            Remember me
                                        </label>
                                        <button type="button" onClick={() => { setMode('signin'); setError(null); setMessage(null); setPendingVerificationEmail(null); }} className="text-xs font-bold text-slate-500 hover:text-black hover:underline block ml-auto">
                                            Back to Password Sign In
                                        </button>
                                    </>
                                )}
                            </div>
                        )}

                        {mode === 'forgot' && (
                            <button type="button" onClick={() => { setMode('signin'); setError(null); setMessage(null); setPendingVerificationEmail(null); }} className="text-xs font-bold text-slate-500 hover:text-black hover:underline block mx-auto">
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
                                    {mode === 'signin'
                                        ? 'Enter Studio'
                                        : mode === 'magic-link'
                                            ? 'Send Magic Link'
                                            : mode === 'forgot'
                                                ? 'Send Reset Link'
                                                : 'Create Account'} <ArrowRight size={20} />
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
