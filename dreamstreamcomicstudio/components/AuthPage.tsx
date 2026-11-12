import React, { useState } from 'react';
import { getAuthPersistMode, getAuthRedirectUrl, setAuthPersistMode, supabase } from '../services/supabase';
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, Lock, MailWarning, Ticket } from 'lucide-react';
import { WaitlistForm } from './WaitlistForm';
import { Turnstile, resetTurnstile } from './Turnstile';
import { turnstileEnabled } from '../services/clientConfig';
import { EMAIL_SERVICE_DOWN, requestAuthEmail } from '../services/authEmail';
import { clearSignInIntents } from '../services/pendingSignIn';
import { isComicsHost } from '../services/productHost';
import { Button } from './ds/Button';
import { Checkbox } from './ds/Checkbox';
import { Field } from './ds/Field';
import { IconButton } from './ds/IconButton';
import { Input } from './ds/Input';
import { Segmented } from './ds/Segmented';
import { ComicsMark } from './comicshost/ComicsMark';
import {
    ACCENT_FILL,
    CHIP,
    CHIP_VARIANT,
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

// New registrations are invite-only for now: existing accounts can still sign in,
// while everyone else can leave their email to request access. Flip this to true
// to re-open self-serve sign-up.
const SIGNUPS_ENABLED = false;

interface AuthPageProps {
    onLoginSuccess: () => void;
    onOpenPrivacy: () => void;
    onOpenTerms: () => void;
    initialMode?: 'signin' | 'request-access';
    /**
     * A captured `?invite=` code (from the invite email link). Holding one unlocks the
     * real sign-up tab even while public signups are off — the invite is auto-redeemed
     * after the first signed-in load (see App.tsx).
     */
    pendingInviteCode?: string | null;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onLoginSuccess, onOpenPrivacy, onOpenTerms, initialMode = 'signin', pendingInviteCode = null }) => {
    const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const MIN_SIGNUP_AGE_YEARS = 8;
    // An invite in hand unlocks real account creation even while public signups are off.
    const signupsAllowed = SIGNUPS_ENABLED || Boolean(pendingInviteCode);
    const [mode, setMode] = useState<'signin' | 'signup' | 'forgot' | 'magic-link' | 'request-access'>(
        pendingInviteCode ? 'signup' : initialMode === 'request-access' && !SIGNUPS_ENABLED ? 'request-access' : 'signin'
    );
    const [isLoading, setIsLoading] = useState(false);
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
            // Our backend sends it (Supabase's own mailer allows ~2 emails/hour project-wide);
            // the direct Supabase call is only the fallback when the backend can't be reached.
            const viaApi = await requestAuthEmail('resend', {
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
                if (!signupsAllowed) {
                    throw new Error('New sign-ups are invite-only right now. Request access and we’ll be in touch.');
                }
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
                const signupData = {
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
                    app: 'main',
                    email: normalizedEmail,
                    password,
                    captchaToken: captchaToken || undefined,
                    data: signupData
                });
                if (viaApi.status === 'error') {
                    if (viaApi.code === 'email_exists') {
                        throw new Error("An account with this email already exists. Please sign in or reset your password.");
                    }
                    if (viaApi.code === 'send_failed') {
                        // The account exists; only the email didn't go out — offer the resend button.
                        setMode('signin');
                        setPassword('');
                        setConfirmPassword('');
                        setPendingVerificationEmail(normalizedEmail);
                    }
                    throw new Error(viaApi.message);
                }
                // Every auth email comes from dreamstreamstudio.ai — never fall back to Supabase's own mailer.
                if (viaApi.status === 'unreachable') throw new Error(EMAIL_SERVICE_DOWN);

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
                    options: { captchaToken: captchaToken || undefined },
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

    // The two choices on the card: signing in (with its reset and magic-link steps) or joining (sign up with an
    // invite, otherwise asking for access). Switching clears what the last attempt said.
    const resetNotices = () => { setError(null); setMessage(null); setPendingVerificationEmail(null); };
    const choice: 'signin' | 'join' = mode === 'signin' || mode === 'forgot' || mode === 'magic-link' ? 'signin' : 'join';
    const chooseSignIn = () => { setMode('signin'); resetNotices(); };
    const chooseJoin = () => { setMode(signupsAllowed ? 'signup' : 'request-access'); resetNotices(); };
    const onChoiceClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (mode !== 'forgot' && mode !== 'magic-link') return;
        const radio = (e.target as HTMLElement).closest('[role="radio"]');
        // In these steps the checked radio is "Sign in" (choice === 'signin').
        if (radio && radio.getAttribute('aria-checked') === 'true') chooseSignIn();
    };
    const showPasswordLabel = showPassword ? 'Hide password' : 'Show password';
    const heading = AUTH_HEADINGS[mode];

    return (
        <main className="flex min-h-[100dvh] min-w-0 flex-col items-center justify-center bg-[var(--ds-canvas)] px-4 py-10 text-[var(--ds-ink)]">
            <AuthBrand />

            <div className={`w-full max-w-md overflow-hidden ${RADIUS_PANEL} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] ${SHADOW_SOFT}`}>
                {/* On the reset and sign-in-link steps "Sign in" is already the checked radio, so the Segmented sends no
                    change: a press on it (click, Space or Enter) still goes back to the password step, as the old tab did. */}
                <div className="border-b border-[var(--ds-hairline-soft)] p-3" onClick={onChoiceClick}>
                    <Segmented
                        label="Sign in or join"
                        fullWidth
                        value={choice}
                        onChange={(next) => (next === 'signin' ? chooseSignIn() : chooseJoin())}
                        options={[
                            { value: 'signin', label: 'Sign in' },
                            { value: 'join', label: signupsAllowed ? 'Sign up' : 'Request access' }
                        ]}
                    />
                </div>

                <div className="p-6 sm:p-8">
                    <header className="mb-6">
                        <h1 className={`text-[length:var(--ds-text-2xl)] leading-8 ${HEADING}`}>{heading.title}</h1>
                        {heading.body ? <p className="mt-1.5 text-[length:var(--ds-text-base)] text-[var(--ds-muted)]">{heading.body}</p> : null}
                    </header>

                    {pendingInviteCode && (
                        <div role="status" className={`mb-6 flex items-start gap-2.5 ${RADIUS_CONTROL} border px-3 py-2.5 text-[length:var(--ds-text-base)] ${STATUS_SURFACE.active}`}>
                            <Ticket aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--ds-muted)]" />
                            <span className="min-w-0">
                                You&apos;ve been invited! Create your account (or sign in) and invite{' '}
                                <span className="font-mono font-medium [overflow-wrap:anywhere]">{pendingInviteCode}</span> will be applied automatically.
                            </span>
                        </div>
                    )}
                    {mode === 'request-access' && (
                        <div className="space-y-5">
                            <span className={`${CHIP} ${CHIP_VARIANT.outline}`}>
                                <Lock aria-hidden className="size-3" /> Invite-only beta
                            </span>
                            <p className="text-[length:var(--ds-text-base)] leading-relaxed text-[var(--ds-muted)]">
                                DreamStream Studio is currently open to existing members only. Drop your email and
                                we’ll reach out the moment new access opens up.
                            </p>
                            <WaitlistForm
                                kind="access"
                                source="auth-request-access"
                                buttonLabel="Request access"
                                onSignIn={chooseSignIn}
                            />
                            <p className="text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">
                                Already have an account?{' '}
                                <button type="button" onClick={chooseSignIn} className={`${textLink} font-medium`}>
                                    Sign in
                                </button>
                            </p>
                        </div>
                    )}

                    {mode !== 'request-access' && (<>
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

                    <form onSubmit={handleAuth} className="space-y-4">
                        {mode === 'signup' && (
                            <Field label="Username" required>
                                <Input
                                    type="text"
                                    required
                                    autoComplete="username"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="font-mono"
                                    placeholder="Super_hero"
                                />
                            </Field>
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

                        <Button type="submit" size="lg" loading={isLoading} className="h-11 w-full">
                            {mode === 'signin'
                                ? 'Enter Studio'
                                : mode === 'magic-link'
                                    ? 'Send the link'
                                    : mode === 'forgot'
                                        ? 'Send reset link'
                                        : 'Create account'} <ArrowRight aria-hidden />
                        </Button>
                    </form>
                    </>)}
                </div>
            </div>

            <p className="mt-8 text-center text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">
                &copy; 2026 DreamStream Inc. All rights reserved.
            </p>
        </main>
    );
};

/** The card's heading for each step: what this step does, in plain words. */
const AUTH_HEADINGS: Record<'signin' | 'signup' | 'forgot' | 'magic-link' | 'request-access', { title: string; body?: string }> = {
    signin: { title: 'Welcome back', body: 'Sign in with your email or username.' },
    signup: { title: 'Create your account' },
    forgot: { title: 'Reset your password', body: 'Enter your email to receive a reset link.' },
    'magic-link': { title: 'Email me a sign-in link', body: 'Enter your email and we will send a secure sign-in link.' },
    'request-access': { title: 'Request access' }
};

/** A link inside a sentence: ink, underlined, the focus outline. */
const textLink = `${RADIUS_CONTROL} text-[var(--ds-ink)] underline underline-offset-2 hover:no-underline ${FOCUS_RING}`;
/** A small secondary step (sign-in link, reset, back): muted text, 44 px tall under a coarse pointer. */
const quietAction = `inline-flex items-center ${RADIUS_CONTROL} text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] hover:underline ${DENSITY.coarse} ${FOCUS_RING}`;

/**
 * The product above the card: Comic Studio's own mark on the comics host, the DreamStream lockup elsewhere.
 * Ink and paper only (no comic chrome: the art belongs to the comics, not to the sign-in form).
 */
const AuthBrand: React.FC = () => {
    const comics = isComicsHost();
    return (
        <div className="mb-8 flex min-w-0 items-center gap-3" data-testid="auth-brand">
            {comics ? (
                <ComicsMark size={44} className="shrink-0" />
            ) : (
                <span
                    aria-hidden
                    className={`flex size-11 shrink-0 items-center justify-center ${RADIUS_CONTROL} ${ACCENT_FILL} ${ON_ACCENT_TEXT} text-xl font-semibold ${FONT_DISPLAY}`}
                >
                    D
                </span>
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`truncate text-[length:var(--ds-text-xl)] leading-7 ${HEADING}`}>{comics ? 'Comic Studio' : 'DreamStream'}</span>
                <span className={OVERLINE}>{comics ? 'DreamStream' : 'Studio access'}</span>
            </span>
        </div>
    );
};
