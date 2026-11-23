import { SignupUsername } from './SignupUsername';
import { USERNAME_REGEX } from '../shared/username';
import { signInWithUsername } from '../services/usernames';
import { userFacingErrorMessage } from '../services/apiErrors';
import React, { useEffect, useRef, useState } from 'react';
import { cancelGoogleSignIn, completeGoogleSignIn, googleSignInAvailable, pendingGoogleSignIn, startGoogleSignIn, type GoogleProfile } from '../services/googleSignIn';
import { GoogleAccountProfile } from './GoogleAccountProfile';
import { getSignupReferralCode } from '../services/memberReferrals';
import type { AuthWorkspace } from '../shared/authWorkspace';
import { getAuthPersistMode, setAuthPersistMode, supabase } from '../services/supabase';
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, MailWarning, Ticket } from 'lucide-react';
import { Turnstile, resetTurnstile } from './Turnstile';
import { turnstileEnabled } from '../services/clientConfig';
import { EMAIL_SERVICE_DOWN, requestAuthEmail } from '../services/authEmail';
import { clearSignInIntents } from '../services/pendingSignIn';
import { isComicsHost, mainFrontPageUrl } from '../services/productHost';
import { Button } from './ds/Button';
import { Checkbox } from './ds/Checkbox';
import { Field } from './ds/Field';
import { IconButton } from './ds/IconButton';
import { Input } from './ds/Input';
import { Segmented } from './ds/Segmented';
import {
    ACCENT_FILL,
    DENSITY,
    FOCUS_RING,
    FONT_DISPLAY,
    HEADING,
    ON_ACCENT_TEXT,
    OVERLINE,
    RADIUS_CONTROL,
    RADIUS_PANEL,
    SHADOW_SOFT,
    STATUS_INK,
    STATUS_SURFACE
} from './chat/studioDesign';

interface AuthPageProps {
    onLoginSuccess: () => void;
    onOpenPrivacy: () => void;
    onOpenTerms: () => void;
    initialMode?: 'signin' | 'signup';
    onModeChange?: (mode: 'signin' | 'signup') => void;
    returnToWorkspace?: AuthWorkspace;
    checkGoogleAvailability?: typeof googleSignInAvailable;
    /** Optional product invitation to redeem after the email is verified. */
    pendingInviteCode?: string | null;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onLoginSuccess, onOpenPrivacy, onOpenTerms, initialMode = 'signin', onModeChange, pendingInviteCode = null, returnToWorkspace, checkGoogleAvailability = googleSignInAvailable }) => {
    const [takenUsername, setTakenUsername] = useState('');
    const [googleConflict, setGoogleConflict] = useState(false);
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const MIN_SIGNUP_AGE_YEARS = 8;
    const [mode, setMode] = useState<'signin' | 'signup' | 'forgot' | 'magic-link'>(pendingInviteCode ? 'signup' : initialMode);
    const [isLoading, setIsLoading] = useState(false);
    const [googleEnabled, setGoogleEnabled] = useState(false);
    const [googleProfile, setGoogleProfile] = useState<{ firstName: string; email: string } | null>(null);
    const googleCallbackHandled = useRef(false);
    const [googleLoading, setGoogleLoading] = useState(false);
    useEffect(() => {
        const request = new AbortController();
        void checkGoogleAvailability(request.signal).then(enabled => {
            if (!request.signal.aborted) setGoogleEnabled(enabled);
        });
        return () => request.abort();
    }, [checkGoogleAvailability]);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [captchaToken, setCaptchaToken] = useState('');

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

    // Consents
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [marketingConsent, setMarketingConsent] = useState(false);
    const maxSignupDob = (() => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setFullYear(date.getFullYear() - MIN_SIGNUP_AGE_YEARS);
        return date.toISOString().slice(0, 10);
    })();

    const handleResendVerification = async () => {
        const normalizedEmail = (pendingVerificationEmail || email || '').trim().toLowerCase();
        if (!EMAIL_REGEX.test(normalizedEmail)) {
            setError('Enter a valid email address to resend verification.');
            return;
        }

        setError(null);
        setMessage(null);
        setIsLoading(true);
        const usedCaptcha = Boolean(captchaToken);
        try {
            if (turnstileEnabled() && !captchaToken) throw new Error('Please complete the verification challenge.');
            const viaApi = await requestAuthEmail('resend', {
                returnToWorkspace,
                email: normalizedEmail,
                app: 'main',
                captchaToken: captchaToken || undefined
            });
            if (viaApi.status === 'error') throw new Error(viaApi.message);
            // Every auth email comes from dreamstreamstudio.ai — never fall back to Supabase's own mailer.
            if (viaApi.status === 'unreachable') throw new Error(EMAIL_SERVICE_DOWN);
            setPendingVerificationEmail(normalizedEmail);
            setMessage('Verification email sent. Check inbox and spam.');
        } catch (err: any) {
            setError(err?.message || 'Failed to resend verification email.');
        } finally {
            setIsLoading(false);
            // A Turnstile token is single-use — if this request spent it, get a fresh one.
            if (usedCaptcha && turnstileEnabled()) {
                setCaptchaToken('');
                resetTurnstile();
            }
        }
    };

    const finishGoogle = async (profile?: GoogleProfile) => {
        setGoogleLoading(true);
        setError(null);
        setGoogleConflict(false);
        try {
            const result = await completeGoogleSignIn(profile);
            if (result.needsProfile === true) {
                setGoogleProfile({ email: result.email, firstName: result.firstName });
            } else {
                clearSignInIntents();
                if (result.destination) window.location.replace(result.destination);
                else onLoginSuccess();
            }
        } catch (err) {
            const code = (err as { code?: string })?.code;
            if (code === 'username-taken' && profile) setTakenUsername(profile.username);
            if (code === 'email-conflict') setGoogleConflict(true);
            setError(userFacingErrorMessage(err, 'Google sign-in could not finish. Try again or use email.'));
        } finally { setGoogleLoading(false); }
    };
    useEffect(() => {
        const resume = () => {
            if (googleCallbackHandled.current) return;
            const pending = pendingGoogleSignIn();
            if (!pending) return;
            googleCallbackHandled.current = true;
            if (pending === 'error') setError('Google sign-in was cancelled or expired. Try again or use email.');
            else void finishGoogle();
        };
        resume();
        window.addEventListener('hashchange', resume);
        return () => window.removeEventListener('hashchange', resume);
    }, []);

    const handleGoogle = async () => {
        if (googleLoading || isLoading) return;
        setError(null);
        setMessage(null);
        setGoogleLoading(true);
        setAuthPersistMode(rememberMe ? 'local' : 'session');
        try {
            if (turnstileEnabled() && !captchaToken) throw new Error('Please complete the verification challenge.');
            await startGoogleSignIn(returnToWorkspace, captchaToken || undefined);
        } catch (err) {
            setError(userFacingErrorMessage(err, 'Google sign-in could not start. Try again or continue with email.'));
            setGoogleLoading(false);
            if (turnstileEnabled()) { setCaptchaToken(''); resetTurnstile(); }
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
            // Bot protection (no-op unless a Turnstile site key is configured).
            if (turnstileEnabled() && !captchaToken) {
                throw new Error('Please complete the verification challenge.');
            }
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

                // Sign up with metadata. Profile rows are created by Supabase DB trigger.
                const referralCode = getSignupReferralCode();
                const signupData = {
                    ...(referralCode ? { referral_code: referralCode } : {}),
                    username: normalizedUsername,
                    first_name: normalizedFirstName,
                    last_name: normalizedLastName || null,
                    phone_number: normalizedPhoneNumber || null,
                    dob: normalizedDob,
                    terms_accepted: termsAccepted,
                    marketing_consent: marketingConsent,
                    email_pref_product_updates: true,
                    email_pref_marketing: marketingConsent
                };
                // Our backend creates the account and sends the confirmation from dreamstreamstudio.ai.
                const viaApi = await requestAuthEmail('signup', {
                    returnToWorkspace,
                    app: 'main',
                    email: normalizedEmail,
                    password,
                    captchaToken: captchaToken || undefined,
                    data: signupData
                });
                if (viaApi.status === 'error') {
                    if (viaApi.code === 'username_taken') setTakenUsername(normalizedUsername);
                    if (viaApi.code === 'email_exists') {
                        throw new Error("An account with this email already exists. Please sign in or reset your password.");
                    }
                    if (viaApi.code === 'send_failed') {
                        // The account exists; only the email didn't go out — offer the resend button.
                        setMode('signin');
                        onModeChange?.('signin');
                        setPassword('');
                        setConfirmPassword('');
                        setPendingVerificationEmail(normalizedEmail);
                    }
                    throw new Error(viaApi.message);
                }
                // Every auth email comes from dreamstreamstudio.ai — never fall back to Supabase's own mailer.
                if (viaApi.status === 'unreachable') throw new Error(EMAIL_SERVICE_DOWN);

                setMessage("For a new account, check your email and open the verification link. Already joined? Sign in below or reset your password.");
                setPendingVerificationEmail(normalizedEmail);
                onModeChange?.('signin');
                setMode('signin');
                setPassword('');
                setConfirmPassword('');
            } else if (mode === 'signin') {
                // Sign In
                const loginInput = email.trim();
                if (!loginInput) throw new Error("Email or username is required.");
                const byEmail = loginInput.includes('@');
                const signInEmail = byEmail ? loginInput.toLowerCase() : null;
                setPendingVerificationEmail(null);
                setAuthPersistMode(rememberMe ? 'local' : 'session');
                const { data: signInData, error: signInError } = byEmail
                    ? await supabase.auth.signInWithPassword({ email: signInEmail!, password, options: { captchaToken: captchaToken || undefined } })
                    : await signInWithUsername(loginInput, password, captchaToken || undefined);
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

                // Success. Signed in with a password: nothing here waits for an emailed link any
                // more (a reset asked for earlier, say), so no link opened later may skip the
                // "Finish signing in?" step on the strength of that request.
                clearSignInIntents();
                setPendingVerificationEmail(null);
                onLoginSuccess();
            } else if (mode === 'magic-link') {
                const normalizedEmail = email.trim().toLowerCase();
                if (!EMAIL_REGEX.test(normalizedEmail)) {
                    throw new Error("Enter a valid email to receive a sign-in link.");
                }
                setAuthPersistMode(rememberMe ? 'local' : 'session');

                const viaApi = await requestAuthEmail('magiclink', {
                    returnToWorkspace,
                    email: normalizedEmail,
                    app: 'main',
                    captchaToken: captchaToken || undefined
                });
                if (viaApi.status === 'error') throw new Error(viaApi.message);
                // Every auth email comes from dreamstreamstudio.ai — never fall back to Supabase's own mailer.
                if (viaApi.status === 'unreachable') throw new Error(EMAIL_SERVICE_DOWN);

                setMessage("Sign-in link sent. Check your email to continue.");
                setMode('signin');
            } else if (mode === 'forgot') {
                const normalizedEmail = email.trim().toLowerCase();
                if (!EMAIL_REGEX.test(normalizedEmail)) {
                    throw new Error("Enter a valid email for password reset.");
                }
                // Forgot Password
                const viaApi = await requestAuthEmail('recovery', {
                    email: normalizedEmail,
                    app: 'main',
                    captchaToken: captchaToken || undefined
                });
                if (viaApi.status === 'error') throw new Error(viaApi.message);
                // Every auth email comes from dreamstreamstudio.ai — never fall back to Supabase's own mailer.
                if (viaApi.status === 'unreachable') throw new Error(EMAIL_SERVICE_DOWN);
                setMessage("Password reset link sent! Check your email.");
                setMode('signin');
            }
        } catch (err: any) {
            setError(err?.message || "Authentication failed.");
        } finally {
            setIsLoading(false);
            // Turnstile tokens are single-use — clear + reset so the next attempt gets a fresh one.
            if (turnstileEnabled()) {
                setCaptchaToken('');
                resetTurnstile();
            }
        }
    };

    const resetNotices = () => { setError(null); setMessage(null); setPendingVerificationEmail(null); setGoogleConflict(false); };
    const choice: 'signin' | 'join' = mode === 'signin' || mode === 'forgot' || mode === 'magic-link' ? 'signin' : 'join';
    const chooseSignIn = () => { setMode('signin'); onModeChange?.('signin'); resetNotices(); };
    const chooseJoin = () => { setMode('signup'); onModeChange?.('signup'); resetNotices(); };
    const onChoiceClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (mode !== 'forgot' && mode !== 'magic-link') return;
        const radio = (e.target as HTMLElement).closest('[role="radio"]');
        // In these steps the checked radio is "Sign in" (choice === 'signin').
        if (radio && radio.getAttribute('aria-checked') === 'true') chooseSignIn();
    };
    const showPasswordLabel = showPassword ? 'Hide password' : 'Show password';
    const heading = AUTH_HEADINGS[mode];
    // On the comics host the page sits under ComicsHeader (the --header-h row), which already carries the product's
    // lockup: the card centres in the space below it (so it is never pushed under the fold) and draws no second brand.
    const comicsHost = isComicsHost();

    return (
        <main
            className={`flex ${comicsHost ? 'min-h-[calc(100dvh-var(--header-h))]' : 'min-h-[100dvh]'} min-w-0 flex-col items-center justify-center bg-[var(--ds-canvas)] px-4 py-10 text-[var(--ds-ink)]`}
        >
            {comicsHost ? null : <AuthBrand />}

            <div className={`w-full max-w-md overflow-hidden ${RADIUS_PANEL} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] ${SHADOW_SOFT}`}>
                {/* On the reset and sign-in-link steps "Sign in" is already the checked radio, so the Segmented sends no
                    change: a press on it (click, Space or Enter) still goes back to the password step, as the old tab did. */}
                {!googleProfile && <div className="border-b border-[var(--ds-hairline-soft)] p-3" onClick={onChoiceClick}>
                    <Segmented
                        label="Sign in or join"
                        fullWidth
                        value={choice}
                        onChange={(next) => (next === 'signin' ? chooseSignIn() : chooseJoin())}
                        options={[
                            { value: 'signin', label: 'Sign in' },
                            { value: 'join', label: 'Sign up' }
                        ]}
                    />
                </div>}

                <div className="p-6 sm:p-8">
                    <header className="mb-6">
                        <h1 className={`text-[length:var(--ds-text-2xl)] leading-8 ${HEADING}`}>{googleProfile ? 'Finish your Google signup' : heading.title}</h1>
                        {heading.body && !googleProfile ? <p className="mt-1.5 text-[length:var(--ds-text-base)] text-[var(--ds-muted)]">{heading.body}</p> : null}
                    </header>

                    {pendingInviteCode && (
                        <div role="status" className={`mb-6 flex items-start gap-2.5 ${RADIUS_CONTROL} border px-3 py-2.5 text-[length:var(--ds-text-base)] ${STATUS_SURFACE.active}`}>
                            <Ticket aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--ds-muted)]" />
                            <span className="min-w-0">
                                Create an account or sign in to check your invite code{' '}
                                <span className="font-mono font-medium [overflow-wrap:anywhere]">{pendingInviteCode}</span>.
                            </span>
                        </div>
                    )}
                    {googleConflict && <Button type="button" variant="outline" className="mb-4 w-full" onClick={() => { setGoogleConflict(false); chooseSignIn(); }}>Sign in with my existing account</Button>}
                    {googleLoading && !googleProfile && <p role="status" className="mb-4 text-[var(--ds-muted)]">Connecting to Google…</p>}
                    {error && (
                        <div role="alert" className={`mb-6 flex items-start gap-2 ${RADIUS_CONTROL} border p-3 text-[length:var(--ds-text-base)] ${STATUS_SURFACE.error}`}>
                            <AlertCircle aria-hidden className={`mt-0.5 size-4 shrink-0 ${STATUS_INK.error}`} />
                            <span className="min-w-0 text-[var(--ds-ink)] [overflow-wrap:anywhere]">{error}</span>
                        </div>
                    )}
                    {message && (
                        <div role="status" className={`mb-6 flex items-start gap-2 ${RADIUS_CONTROL} border p-3 text-[length:var(--ds-text-base)] ${STATUS_SURFACE.healthy}`}>
                            <CheckCircle2 aria-hidden className={`mt-0.5 size-4 shrink-0 ${STATUS_INK.healthy}`} />
                            <span className="min-w-0 text-[var(--ds-ink)] [overflow-wrap:anywhere]">{message}</span>
                        </div>
                    )}
                    {mode === 'signin' && pendingVerificationEmail && (
                        <div className={`mb-6 ${RADIUS_CONTROL} border p-3 text-[length:var(--ds-text-base)] ${STATUS_SURFACE.attention}`}>
                            <p className="mb-1 flex items-start gap-2">
                                <MailWarning aria-hidden className={`mt-0.5 size-4 shrink-0 ${STATUS_INK.attention}`} />
                                <span className="min-w-0 [overflow-wrap:anywhere]">
                                    Email not verified for <span className="font-mono">{pendingVerificationEmail}</span>.
                                </span>
                            </p>
                            <button
                                type="button"
                                onClick={handleResendVerification}
                                disabled={isLoading}
                                className={`inline-flex items-center ${textLink} font-medium ${DENSITY.coarse} disabled:opacity-60`}
                            >
                                {isLoading ? 'Sending…' : 'Resend verification email'}
                            </button>
                        </div>
                    )}

                    {!googleProfile && googleEnabled && (mode === 'signup' || mode === 'signin') && (
                        <div className="mb-5">
                            <Button type="button" variant="outline" size="lg" className="w-full" loading={googleLoading} disabled={isLoading} onClick={handleGoogle}>
                                Continue with Google
                            </Button>
                            <p className="mt-4 text-center text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">Or continue with email</p>
                        </div>
                    )}
                    {googleProfile ? (
                        <GoogleAccountProfile {...googleProfile} maxDob={maxSignupDob} busy={googleLoading} takenUsername={takenUsername} onEditUsername={() => setTakenUsername('')}
                            onSubmit={profile => void finishGoogle(profile)} onCancel={() => {
                                cancelGoogleSignIn();
                                setGoogleProfile(null);
                                chooseSignIn();
                            }} />
                    ) : <form onSubmit={handleAuth} className="space-y-4">
                        {mode === 'signup' && (
                            <SignupUsername value={username} onChange={value => { setUsername(value); setTakenUsername(''); }} taken={takenUsername}
                                onSignIn={() => { setEmail(username); setPassword(''); chooseSignIn(); }} />
                        )}

                        {mode === 'signup' && (
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <Field label="First name" required>
                                    <Input
                                        type="text"
                                        required
                                        autoComplete="given-name"
                                        value={firstName}
                                        onChange={(e) => setFirstName(e.target.value)}
                                        placeholder="Super"
                                    />
                                </Field>
                                <Field label="Last name (optional)">
                                    <Input
                                        type="text"
                                        autoComplete="family-name"
                                        value={lastName}
                                        onChange={(e) => setLastName(e.target.value)}
                                        placeholder="Hero"
                                    />
                                </Field>
                            </div>
                        )}

                        <Field label={mode === 'signin' ? 'Email or username' : 'Email'} required>
                            <Input
                                type={mode === 'signin' ? 'text' : 'email'}
                                required
                                autoComplete={mode === 'signin' ? 'username' : 'email'}
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder={mode === 'signin' ? "user@example.com or username" : "user@example.com"}
                            />
                        </Field>

                        {mode === 'signup' && (
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <Field label="Date of birth" required description={`Must be at least ${MIN_SIGNUP_AGE_YEARS} years old.`}>
                                    <Input
                                        type="date"
                                        required
                                        autoComplete="bday"
                                        value={dob}
                                        onChange={(e) => setDob(e.target.value)}
                                        max={maxSignupDob}
                                    />
                                </Field>
                                <Field label="Phone number (optional)">
                                    <Input
                                        type="tel"
                                        autoComplete="tel"
                                        value={phoneNumber}
                                        onChange={(e) => setPhoneNumber(e.target.value)}
                                        placeholder="+1 555 123 4567"
                                    />
                                </Field>
                            </div>
                        )}

                        {mode !== 'forgot' && mode !== 'magic-link' && (
                            <Field label="Password" required>
                                <div className="relative">
                                    <Input
                                        type={showPassword ? "text" : "password"}
                                        required
                                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="pr-12"
                                        placeholder="••••••••"
                                    />
                                    <IconButton
                                        label={showPasswordLabel}
                                        aria-pressed={showPassword}
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--ds-muted)]"
                                    >
                                        {showPassword ? <EyeOff /> : <Eye />}
                                    </IconButton>
                                </div>
                            </Field>
                        )}

                        {mode === 'signup' && (
                            <Field
                                label="Confirm password"
                                required
                                error={confirmPassword && password !== confirmPassword ? 'The passwords don’t match yet.' : undefined}
                            >
                                <Input
                                    type={showPassword ? "text" : "password"}
                                    required
                                    autoComplete="new-password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    placeholder="••••••••"
                                />
                            </Field>
                        )}

                        {mode === 'signup' && (
                            <div className="flex flex-col gap-3 pt-2">
                                <Checkbox
                                    checked={termsAccepted}
                                    onCheckedChange={setTermsAccepted}
                                    label={
                                        <span>
                                            I accept the{' '}
                                            <a href="/?view=terms" onClick={(e) => { e.preventDefault(); onOpenTerms(); }} className={textLink}>Terms and Conditions</a>
                                            {' '}and{' '}
                                            <a href="/?view=privacy" onClick={(e) => { e.preventDefault(); onOpenPrivacy(); }} className={textLink}>Privacy Policy</a>.
                                        </span>
                                    }
                                />
                                <Checkbox
                                    checked={marketingConsent}
                                    onCheckedChange={setMarketingConsent}
                                    label="(Optional) Send me marketing emails and updates."
                                />
                            </div>
                        )}

                        {(mode === 'signin' || mode === 'magic-link') && (
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
                                <Checkbox checked={rememberMe} onCheckedChange={setRememberMe} label="Remember me" />
                                {mode === 'signin' ? (
                                    <div className="flex flex-wrap items-center gap-x-3">
                                        <button type="button" onClick={() => { setMode('magic-link'); resetNotices(); }} className={quietAction}>
                                            Email me a sign-in link
                                        </button>
                                        <button type="button" onClick={() => { setMode('forgot'); resetNotices(); }} className={quietAction}>
                                            Forgot password?
                                        </button>
                                    </div>
                                ) : (
                                    <button type="button" onClick={chooseSignIn} className={`${quietAction} ml-auto`}>
                                        Back to password sign-in
                                    </button>
                                )}
                            </div>
                        )}

                        {mode === 'forgot' && (
                            <div className="flex justify-center">
                                <button type="button" onClick={chooseSignIn} className={quietAction}>
                                    Back to sign in
                                </button>
                            </div>
                        )}

                        {turnstileEnabled() && (
                            <div className="flex justify-center">
                                <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action={mode} />
                            </div>
                        )}

                        <Button type="submit" size="lg" loading={isLoading} disabled={googleLoading} className="h-11 w-full">
                            {mode === 'signin'
                                ? 'Enter Studio'
                                : mode === 'magic-link'
                                    ? 'Send the link'
                                    : mode === 'forgot'
                                        ? 'Send reset link'
                                        : 'Create account'} <ArrowRight aria-hidden />
                        </Button>
                    </form>}
                </div>
            </div>

            {comicsHost && mode !== 'signup' ? (
                <p className="mt-6 text-center text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">
                    Have a DreamStream account on the main site?{' '}
                    <a href={mainFrontPageUrl()} className={`inline-flex items-center justify-center ${textLink} font-medium ${DENSITY.coarseSquare}`}>
                        Sign in there
                    </a>
                </p>
            ) : null}

            <p className="mt-8 text-center text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">
                &copy; 2026 DreamStream Inc. All rights reserved.
            </p>
        </main>
    );
};

/** The card's heading for each step: what this step does, in plain words. */
const AUTH_HEADINGS: Record<'signin' | 'signup' | 'forgot' | 'magic-link', { title: string; body?: string }> = {
    signin: { title: 'Welcome back', body: 'Sign in with your email or username.' },
    signup: { title: 'Create your account', body: 'Verify your email to enter the studio. You can set up AI usage after signing in.' },
    forgot: { title: 'Reset your password', body: 'Enter your email to receive a reset link.' },
    'magic-link': { title: 'Email me a sign-in link', body: 'Enter your email and we will send a secure sign-in link.' }
};

/** A link inside a sentence: ink, underlined, the focus outline. */
const textLink = `${RADIUS_CONTROL} text-[var(--ds-ink)] underline underline-offset-2 hover:no-underline ${FOCUS_RING}`;
/** A small secondary step (sign-in link, reset, back): muted text, 44 px tall under a coarse pointer. */
const quietAction = `inline-flex items-center ${RADIUS_CONTROL} text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] hover:underline ${DENSITY.coarse} ${FOCUS_RING}`;

/**
 * The product above the card on the main site: the DreamStream lockup. (On the comics host ComicsHeader carries
 * Comic Studio's lockup right above the page, so the card draws none.) Ink and paper only: no comic chrome.
 */
const AuthBrand: React.FC = () => (
    <div className="mb-8 flex min-w-0 items-center gap-3" data-testid="auth-brand">
        <span
            aria-hidden
            className={`flex size-11 shrink-0 items-center justify-center ${RADIUS_CONTROL} ${ACCENT_FILL} ${ON_ACCENT_TEXT} text-xl font-semibold ${FONT_DISPLAY}`}
        >
            D
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
            <span className={`truncate text-[length:var(--ds-text-xl)] leading-7 ${HEADING}`}>DreamStream</span>
            <span className={OVERLINE}>Studio access</span>
        </span>
    </div>
);
