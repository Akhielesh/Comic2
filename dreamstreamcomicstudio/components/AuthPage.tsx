/**
 * Sign in, create an account (with an invite), request access, a sign-in link by email and a password
 * reset: one page on the Atlas design system (docs/design/atlas-skin.md, the Atlas AuthShell / AuthForm).
 *
 * The rules are the ones this page always enforced, in the same order and with the same words: a
 * Turnstile token when Turnstile is on, the email format, the username format (3–20 letters, numbers or
 * underscores) and its availability (resolve_email_from_username), a first name, an 8+ character password
 * typed twice, the Terms, and a date of birth at least MIN_SIGNUP_AGE_YEARS ago. Sign-in still takes an
 * email or a username, refuses an unconfirmed email and offers the resend. Every email goes out through our
 * backend (services/authEmail.ts), never Supabase's mailer. Nothing here changes an endpoint, a redirect or
 * where the session is stored ("Remember me": services/supabase.ts setAuthPersistMode).
 *
 * What the page adds: the form validates in script (`noValidate`), so a problem with one field marks that
 * field (aria-invalid, the message under it, focus moved to it) instead of a browser bubble; problems the
 * server reports sit in one alert region and results in one status region, both always mounted so a screen
 * reader hears each new message; Enter that only commits an IME composition never submits; a submit while
 * one is running is ignored; the consent links open in a new tab so a half-filled form survives; the
 * header's Request access reaches this page even while it is already open; and an invite captured after the
 * page opened (a protected view's redirect got here first) opens the sign-up form.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleAlert, Eye, EyeOff, Lock, Mail, MailWarning, Ticket, type LucideIcon } from 'lucide-react';
import { getAuthPersistMode, setAuthPersistMode, supabase } from '../services/supabase';
import { WaitlistForm } from './WaitlistForm';
import { Turnstile, resetTurnstile } from './Turnstile';
import { turnstileEnabled } from '../services/clientConfig';
import { EMAIL_SERVICE_DOWN, requestAuthEmail } from '../services/authEmail';
import { clearSignInIntents } from '../services/pendingSignIn';
import { Button, Checkbox, Field, IconButton, Input, Segmented, type InputProps } from './ds';
import { FOCUS_RING, FONT_DISPLAY, INVERSE_SURFACE, OVERLINE, STATUS_INK, STATUS_SURFACE, TONE_TEXT, type StatusState } from './chat/studioDesign';
import { StudioLogo, StudioMark, type Studio } from './brand';
import { cn } from '../lib/utils';

// New registrations are invite-only for now: existing accounts can still sign in,
// while everyone else can leave their email to request access. Flip this to true
// to re-open self-serve sign-up.
const SIGNUPS_ENABLED = false;

const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_SIGNUP_AGE_YEARS = 8;

/** The legal pages as restorable app views, opened in a new tab from the sign-up form (WaitlistForm does the same). */
const TERMS_HREF = '/?view=terms';
const PRIVACY_HREF = '/?view=privacy';

type AuthMode = 'signin' | 'signup' | 'forgot' | 'magic-link' | 'request-access';
/** The fields a validation message can point at (the control it marks and focuses). */
type AuthField = 'login' | 'email' | 'username' | 'firstName' | 'password' | 'confirmPassword' | 'terms' | 'dob';

/** A problem with one field: shown under that field, which is marked invalid and focused. */
class FieldError extends Error {
    readonly field: AuthField;
    constructor(field: AuthField, message: string) {
        super(message);
        this.field = field;
    }
}

/**
 * Enter that commits an IME composition (Japanese, Chinese, Korean input…) must not submit the form.
 * Chromium and Firefox flag it with `isComposing`; Safari ends the composition first and sends the
 * key as keyCode 229 ("Process").
 */
export const isImeEnter = (e: { key: string; isComposing?: boolean; keyCode?: number }): boolean =>
    e.key === 'Enter' && (Boolean(e.isComposing) || e.keyCode === 229);

interface AuthPageProps {
    onLoginSuccess: () => void;
    /** The page footer's Privacy Policy link (the sign-up consent link opens the policy in a new tab instead). */
    onOpenPrivacy: () => void;
    /** The page footer's Terms link (the sign-up consent link opens the Terms in a new tab instead). */
    onOpenTerms: () => void;
    initialMode?: 'signin' | 'request-access';
    /**
     * A captured `?invite=` code (from the invite email link). Holding one unlocks the
     * real sign-up tab even while public signups are off — the invite is auto-redeemed
     * after the first signed-in load (see App.tsx).
     */
    pendingInviteCode?: string | null;
}

// ── Page pieces ─────────────────────────────────────────────────────────────────

const PAGE_TITLE = `${FONT_DISPLAY} m-0 text-balance text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] text-ds-ink [overflow-wrap:anywhere] focus:outline-none sm:text-[2.5rem]`;
const PAGE_LEAD = 'm-0 text-pretty text-[15px] leading-7 text-ds-muted';
const EYEBROW = `${OVERLINE} inline-flex w-fit items-center gap-1.5 rounded-full border border-ds-hairline px-2.5 py-1`;
/** A quiet text action inside the form (Forgot password?, Back to sign in): ink on hover, the underline draws in. */
const TEXT_ACTION = `ds-link rounded-[var(--ds-radius-sm)] bg-origin-content text-[13px] font-medium text-ds-muted transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:text-ds-ink coarse:py-3 ${FOCUS_RING}`;
/** The page footer's links: TEXT_ACTION at the meta size. */
const FOOTER_ACTION = `ds-link rounded-[var(--ds-radius-sm)] bg-origin-content text-xs text-ds-muted transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:text-ds-ink coarse:py-3 ${FOCUS_RING}`;
/** A link inside a sentence (the consent links, "Already have an account? Sign in"). */
const INLINE_LINK = `rounded-[var(--ds-radius-sm)] font-medium text-ds-ink underline decoration-ds-ink/40 underline-offset-[3px] transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:decoration-ds-ink ${FOCUS_RING}`;
/** The full-width primary and secondary actions (Atlas's 44 px auth buttons). */
const WIDE_BUTTON = 'h-11 w-full text-[15px]';

/** A message with a status: the hue sits on the edge, the tint and the icon; the words stay ink. */
function AuthNotice({ tone, icon: Icon, children }: { tone: StatusState; icon: LucideIcon; children: React.ReactNode }) {
    return (
        <div className={cn('ds-rise-in flex items-start gap-3 rounded-[var(--ds-radius-feature)] border px-4 py-3.5 text-sm leading-6 text-ds-ink', STATUS_SURFACE[tone])}>
            <Icon aria-hidden="true" className={cn('mt-1 size-4 shrink-0', STATUS_INK[tone])} />
            <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
        </div>
    );
}

function OrDivider() {
    return (
        <div className="flex items-center gap-4 text-xs text-ds-muted">
            <span aria-hidden="true" className="h-px flex-1 bg-ds-hairline" />
            <span>or</span>
            <span aria-hidden="true" className="h-px flex-1 bg-ds-hairline" />
        </div>
    );
}

interface PasswordInputProps extends Omit<InputProps, 'type'> {
    visible: boolean;
    onToggleVisible?: () => void;
    /** The ids the show / hide toggle controls (the password and its confirmation share one toggle). */
    controls?: string;
}

/**
 * A password field with a show / hide toggle inside it (Atlas AuthForm). The toggle keeps one name and
 * reports its state with aria-pressed, so a screen reader hears "Show password, toggle button, pressed";
 * the eye is struck through while the password shows.
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
    { visible, onToggleVisible, controls, className, ...props },
    ref
) {
    return (
        <div className="relative">
            <Input
                {...props}
                ref={ref}
                type={visible ? 'text' : 'password'}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={cn(onToggleVisible && 'pr-11 coarse:pr-12', className)}
            />
            {onToggleVisible ? (
                <IconButton
                    label="Show password"
                    title={null}
                    aria-pressed={visible}
                    aria-controls={controls}
                    onClick={onToggleVisible}
                    className="absolute inset-y-0 right-1 my-auto text-ds-muted hover:text-ds-ink coarse:right-0"
                >
                    {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </IconButton>
            ) : null}
        </div>
    );
});

const PANEL_STUDIOS: ReadonlyArray<{ studio: Studio; name: string; line: string }> = [
    { studio: 'comic', name: 'Comic Studio', line: 'Talk an idea through and get a finished comic.' },
    { studio: 'stream', name: 'Stream Studio', line: 'Live events, a baby monitor and family calls.' },
    { studio: 'dreamstream', name: 'Chat Studio', line: 'An assistant that works with your apps.' }
];

/**
 * The ink panel beside the form on wide screens (Atlas AuthBrandPanel): the house lockup, one line about
 * the account and the studios it opens, on the 28 px hero frame with 16 px cards. In dark it stays a raised
 * dark panel (INVERSE_SURFACE). It stays in view under the 64 px site header while a long sign-up form
 * scrolls. Hidden below `lg`, where the form is the whole page.
 */
function BrandPanel() {
    return (
        <aside aria-label="About DreamStream Studio" className="hidden min-w-0 lg:sticky lg:top-24 lg:flex lg:w-[44%] lg:max-w-[34rem] lg:shrink-0 lg:self-start">
            <div className={cn(INVERSE_SURFACE, 'ds-fade-in relative flex h-[min(46rem,calc(100dvh-8rem))] min-h-[34rem] w-full flex-col justify-between gap-12 overflow-hidden rounded-[var(--ds-radius-hero)] p-10 shadow-[shadow:var(--ds-shadow-panel)] xl:p-12')}>
                {/* The dot grid reads the ink; on the inverted panel it draws in the page colour. */}
                <div
                    aria-hidden="true"
                    className="ds-grid-backdrop pointer-events-none absolute inset-0"
                    style={{ '--ds-grid-dot': 'color-mix(in srgb, var(--ds-canvas) 16%, transparent)' } as React.CSSProperties}
                />
                <StudioLogo studio="dreamstream" className="relative" />
                <div className="relative">
                    <p className="ds-overline-display m-0 text-inherit opacity-70">Invite-only beta</p>
                    <p className="m-0 mt-5 text-balance text-[2rem] font-semibold leading-[1.1] tracking-[-0.03em] xl:text-[2.5rem]">
                        One account for every studio.
                    </p>
                    <ul className="ds-stagger m-0 mt-9 list-none space-y-3 p-0">
                        {PANEL_STUDIOS.map((s) => (
                            <li
                                key={s.name}
                                className="flex items-start gap-4 rounded-[var(--ds-radius-feature)] border border-[color:color-mix(in_srgb,var(--ds-canvas)_14%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-canvas)_6%,transparent)] p-4"
                            >
                                <StudioMark studio={s.studio} className="size-9 shrink-0" />
                                <div className="min-w-0">
                                    <p className="m-0 font-medium">{s.name}</p>
                                    <p className="m-0 mt-0.5 text-sm leading-6 opacity-70">{s.line}</p>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
                <p className="relative m-0 text-xs opacity-70">New accounts are invite-only during the beta. Existing members sign in as always.</p>
            </div>
        </aside>
    );
}

// ── The page ────────────────────────────────────────────────────────────────────

export const AuthPage: React.FC<AuthPageProps> = ({ onLoginSuccess, onOpenPrivacy, onOpenTerms, initialMode = 'signin', pendingInviteCode = null }) => {
    // An invite in hand unlocks real account creation even while public signups are off.
    const signupsAllowed = SIGNUPS_ENABLED || Boolean(pendingInviteCode);
    const [mode, setMode] = useState<AuthMode>(
        pendingInviteCode ? 'signup' : initialMode === 'request-access' && !SIGNUPS_ENABLED ? 'request-access' : 'signin'
    );
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldError, setFieldError] = useState<{ field: AuthField; message: string } | null>(null);
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

    // Focus targets: the title after a switch inside the page, a field when a message points at it.
    const titleRef = useRef<HTMLHeadingElement>(null);
    const focusTitleNext = useRef(false);
    const fieldRefs = useRef<Partial<Record<AuthField, HTMLInputElement | null>>>({});
    const bindField = (field: AuthField) => (el: HTMLInputElement | null) => {
        fieldRefs.current[field] = el;
    };

    const goTo = (next: AuthMode, { focusTitle = false }: { focusTitle?: boolean } = {}) => {
        setMode(next);
        setError(null);
        setMessage(null);
        setFieldError(null);
        setPendingVerificationEmail(null);
        // The link that was pressed is gone after the switch: land on the new title, not on <body>.
        focusTitleNext.current = focusTitle && next !== mode;
    };

    useEffect(() => {
        if (!focusTitleNext.current) return;
        focusTitleNext.current = false;
        titleRef.current?.focus();
    }, [mode]);

    // The header's "Sign in" / "Request access" set `initialMode` while this page may already be open:
    // follow a change, as a fresh visit would.
    const lastInitialMode = useRef(initialMode);
    useEffect(() => {
        if (lastInitialMode.current === initialMode) return;
        lastInitialMode.current = initialMode;
        goTo(initialMode === 'request-access' ? (signupsAllowed ? 'signup' : 'request-access') : 'signin');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialMode]);

    // An invite can arrive after this page opened: App captures `?invite=` in an effect, after a protected
    // view has already put a signed-out visitor here. Open the sign-up form for it, unless they started typing.
    const lastInvite = useRef(pendingInviteCode);
    useEffect(() => {
        const had = lastInvite.current;
        lastInvite.current = pendingInviteCode;
        if (had || !pendingInviteCode) return;
        if ((mode === 'signin' || mode === 'request-access') && !email && !password) goTo('signup');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingInviteCode]);

    // A message about one field moves focus there, so the label, the problem and the field are read together.
    useEffect(() => {
        if (fieldError) fieldRefs.current[fieldError.field]?.focus();
    }, [fieldError]);

    const errorFor = (field: AuthField) => (fieldError?.field === field ? fieldError.message : undefined);
    /** Editing a field clears its own message (the page-level alert stays until the next attempt). */
    const edited = (field: AuthField) => {
        if (fieldError?.field === field) setFieldError(null);
    };

    const handleResendVerification = async () => {
        if (isLoading) return;
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
        // The button is busy (aria-disabled, so it keeps focus), not disabled: Enter in a field would
        // still submit, and twice is never meant.
        if (isLoading) return;
        setError(null);
        setFieldError(null);
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

                if (!normalizedEmail) throw new FieldError('email', "Email is required.");
                if (!EMAIL_REGEX.test(normalizedEmail)) throw new FieldError('email', "Please enter a valid email.");
                if (!normalizedUsername) throw new FieldError('username', "Username is required.");
                if (!USERNAME_REGEX.test(normalizedUsername)) {
                    throw new FieldError('username', "Username must be 3-20 chars and use only letters, numbers, or underscore.");
                }
                if (!normalizedFirstName) throw new FieldError('firstName', "First name is required.");
                if (password.length < 8) throw new FieldError('password', "Password must be at least 8 characters.");
                if (password !== confirmPassword) throw new FieldError('confirmPassword', "Passwords do not match.");
                if (!termsAccepted) throw new FieldError('terms', "You must accept the Terms & Conditions.");
                if (!normalizedDob) throw new FieldError('dob', "Date of birth is required.");

                const dobDate = new Date(`${normalizedDob}T00:00:00`);
                if (Number.isNaN(dobDate.getTime())) throw new FieldError('dob', "Date of birth must be valid.");
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                if (dobDate > today) throw new FieldError('dob', "Date of birth cannot be in the future.");
                const minAllowedDob = new Date(today);
                minAllowedDob.setFullYear(today.getFullYear() - MIN_SIGNUP_AGE_YEARS);
                if (dobDate > minAllowedDob) throw new FieldError('dob', `You must be at least ${MIN_SIGNUP_AGE_YEARS} years old to sign up.`);

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
                        throw new FieldError('username', "Username is already taken. Please choose another.");
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
                if (!loginInput) throw new FieldError('login', "Email or username is required.");
                // The browser's own `required` check used to stop an empty password before this point.
                if (!password) throw new FieldError('password', "Enter your password.");
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
                        throw new FieldError('login', "Username not found. Please use your email.");
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
                    throw new FieldError('email', "Enter a valid email to receive a magic link.");
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

                setMessage("Magic link sent! Check your email to continue.");
                setMode('signin');
            } else if (mode === 'forgot') {
                const normalizedEmail = email.trim().toLowerCase();
                if (!EMAIL_REGEX.test(normalizedEmail)) {
                    throw new FieldError('email', "Enter a valid email for password reset.");
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
            if (err instanceof FieldError) setFieldError({ field: err.field, message: err.message });
            else setError(err?.message || "Authentication failed.");
        } finally {
            setIsLoading(false);
            // Turnstile tokens are single-use — clear + reset so the next attempt gets a fresh one.
            if (turnstileEnabled()) {
                setCaptchaToken('');
                resetTurnstile();
            }
        }
    };

    // IME-safe Enter: committing a composition never submits (isImeEnter).
    const onFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
        if (isImeEnter({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) e.preventDefault();
    };

    const isSignInGroup = mode === 'signin' || mode === 'forgot' || mode === 'magic-link';
    const joinLabel = signupsAllowed ? 'Create account' : 'Request access';

    const copy: Record<AuthMode, { eyebrow: string; title: string; lead: string }> = {
        signin: {
            eyebrow: 'DreamStream Studio',
            title: 'Sign in',
            lead: 'Welcome back. Use your email or username and your password, or get a sign-in link by email.'
        },
        'magic-link': {
            eyebrow: 'Sign in with email',
            title: 'Get a sign-in link',
            lead: 'Enter your account’s email and we’ll send a secure link that signs you in. No password needed.'
        },
        forgot: {
            eyebrow: 'Password help',
            title: 'Reset your password',
            lead: 'Enter your account’s email and we’ll send a link to choose a new password.'
        },
        signup: {
            eyebrow: pendingInviteCode ? 'You’re invited' : 'New account',
            title: 'Create your account',
            lead: 'One DreamStream account signs you in to every studio.'
        },
        'request-access': {
            eyebrow: 'Invite-only beta',
            title: 'Request access',
            lead: 'DreamStream Studio is open to existing members only for now. Leave your email and we’ll reach out the moment new access opens up.'
        }
    };
    const page = copy[mode];

    const submitLabel =
        mode === 'signin'
            ? isLoading ? 'Signing in…' : 'Sign in'
            : mode === 'magic-link'
                ? isLoading ? 'Sending link…' : 'Send sign-in link'
                : mode === 'forgot'
                    ? isLoading ? 'Sending link…' : 'Send reset link'
                    : isLoading ? 'Creating account…' : 'Create account';

    const year = new Date().getFullYear();

    return (
        <div className="min-h-[calc(100dvh-4rem)] w-full bg-ds-canvas text-ds-ink">
            <div className="mx-auto flex w-full max-w-6xl items-stretch gap-10 px-4 py-10 sm:px-6 sm:py-14 lg:gap-14 lg:py-16">
                <section aria-labelledby="auth-title" className="flex min-w-0 flex-1 justify-center">
                    <div className="flex w-full max-w-[26.25rem] flex-col">
                        <Segmented
                            label="Account"
                            fullWidth
                            value={isSignInGroup ? 'signin' : 'join'}
                            onChange={(v) => (v === 'signin' ? goTo('signin') : goTo(signupsAllowed ? 'signup' : 'request-access'))}
                            options={[
                                { value: 'signin', label: 'Sign in' },
                                { value: 'join', label: joinLabel }
                            ]}
                        />

                        <header key={mode} className="ds-rise-in mt-8 flex flex-col gap-3">
                            <p className={cn(EYEBROW, 'm-0')}>
                                {mode === 'request-access' ? <Lock aria-hidden="true" className="size-3" /> : null}
                                {page.eyebrow}
                            </p>
                            <h1 id="auth-title" ref={titleRef} tabIndex={-1} className={PAGE_TITLE}>
                                {page.title}
                            </h1>
                            <p className={PAGE_LEAD}>{page.lead}</p>
                        </header>

                        {/* Always mounted, so each new message is announced: problems assertively, results politely. */}
                        <div aria-live="assertive" aria-atomic="true" data-slot="auth-alert" className="[&:not(:empty)]:mt-6">
                            {error ? (
                                <AuthNotice tone="error" icon={CircleAlert}>
                                    {error}
                                </AuthNotice>
                            ) : null}
                        </div>
                        <div aria-live="polite" aria-atomic="true" data-slot="auth-status" className="[&:not(:empty)]:mt-6">
                            {message ? (
                                <AuthNotice tone="healthy" icon={CheckCircle2}>
                                    {message}
                                </AuthNotice>
                            ) : null}
                        </div>

                        {pendingInviteCode ? (
                            <div className="mt-6">
                                <AuthNotice tone="active" icon={Ticket}>
                                    You’ve been invited. Create your account (or sign in) and invite{' '}
                                    <span className="font-mono text-[13px] font-medium">{pendingInviteCode}</span> is applied automatically.
                                </AuthNotice>
                            </div>
                        ) : null}

                        {mode === 'signin' && pendingVerificationEmail ? (
                            <div className="mt-6">
                                <AuthNotice tone="attention" icon={MailWarning}>
                                    <p className="m-0">
                                        Email not verified for <span className="font-medium">{pendingVerificationEmail}</span>.
                                    </p>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="mt-3"
                                        loading={isLoading}
                                        onClick={handleResendVerification}
                                    >
                                        {isLoading ? 'Sending…' : 'Resend verification email'}
                                    </Button>
                                </AuthNotice>
                            </div>
                        ) : null}

                        {mode === 'request-access' ? (
                            <div className="mt-8 flex flex-col gap-6">
                                <WaitlistForm
                                    kind="access"
                                    source="auth-request-access"
                                    buttonLabel="Request access"
                                    onSignIn={() => goTo('signin', { focusTitle: true })}
                                />
                                <p className="m-0 border-t border-ds-hairline pt-6 text-sm text-ds-muted">
                                    Already have an account?{' '}
                                    <button type="button" onClick={() => goTo('signin', { focusTitle: true })} className={INLINE_LINK}>
                                        Sign in
                                    </button>
                                </p>
                            </div>
                        ) : (
                            <form noValidate onSubmit={handleAuth} onKeyDown={onFormKeyDown} className="mt-8 flex flex-col gap-5">
                                {mode === 'signin' ? (
                                    <Field label="Email or username" error={errorFor('login')} required>
                                        <Input
                                            ref={bindField('login')}
                                            name="username"
                                            autoComplete="username"
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            spellCheck={false}
                                            value={email}
                                            onChange={(e) => {
                                                setEmail(e.target.value);
                                                edited('login');
                                            }}
                                            placeholder="you@example.com"
                                        />
                                    </Field>
                                ) : (
                                    <Field label="Email" error={errorFor('email')} required>
                                        <Input
                                            ref={bindField('email')}
                                            type="email"
                                            name="email"
                                            inputMode="email"
                                            autoComplete="email"
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            spellCheck={false}
                                            value={email}
                                            onChange={(e) => {
                                                setEmail(e.target.value);
                                                edited('email');
                                            }}
                                            placeholder="you@example.com"
                                        />
                                    </Field>
                                )}

                                {mode === 'signup' ? (
                                    <>
                                        <Field
                                            label="Username"
                                            description="3–20 characters: letters, numbers or underscores."
                                            error={errorFor('username')}
                                            required
                                        >
                                            <Input
                                                ref={bindField('username')}
                                                name="handle"
                                                autoComplete="nickname"
                                                autoCapitalize="none"
                                                autoCorrect="off"
                                                spellCheck={false}
                                                maxLength={20}
                                                value={username}
                                                onChange={(e) => {
                                                    setUsername(e.target.value);
                                                    edited('username');
                                                }}
                                                placeholder="super_hero"
                                            />
                                        </Field>
                                        <div className="grid gap-5 medium:grid-cols-2 medium:gap-4">
                                            <Field label="First name" error={errorFor('firstName')} required>
                                                <Input
                                                    ref={bindField('firstName')}
                                                    name="given-name"
                                                    autoComplete="given-name"
                                                    value={firstName}
                                                    onChange={(e) => {
                                                        setFirstName(e.target.value);
                                                        edited('firstName');
                                                    }}
                                                />
                                            </Field>
                                            <Field label="Last name (optional)">
                                                <Input name="family-name" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                                            </Field>
                                        </div>
                                    </>
                                ) : null}

                                {mode === 'signin' || mode === 'signup' ? (
                                    <Field
                                        label="Password"
                                        description={mode === 'signup' ? 'At least 8 characters.' : undefined}
                                        error={errorFor('password')}
                                        required
                                        id="auth-password"
                                    >
                                        <PasswordInput
                                            ref={bindField('password')}
                                            name="password"
                                            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                                            visible={showPassword}
                                            onToggleVisible={() => setShowPassword((v) => !v)}
                                            controls={mode === 'signup' ? 'auth-password auth-confirm-password' : 'auth-password'}
                                            value={password}
                                            onChange={(e) => {
                                                setPassword(e.target.value);
                                                edited('password');
                                            }}
                                        />
                                    </Field>
                                ) : null}

                                {mode === 'signup' ? (
                                    <>
                                        <Field label="Confirm password" error={errorFor('confirmPassword')} required id="auth-confirm-password">
                                            <PasswordInput
                                                ref={bindField('confirmPassword')}
                                                name="confirm-password"
                                                autoComplete="new-password"
                                                visible={showPassword}
                                                value={confirmPassword}
                                                aria-invalid={confirmPassword && password !== confirmPassword ? true : undefined}
                                                onChange={(e) => {
                                                    setConfirmPassword(e.target.value);
                                                    edited('confirmPassword');
                                                }}
                                            />
                                        </Field>
                                        <div className="grid gap-5 medium:grid-cols-2 medium:gap-4">
                                            <Field
                                                label="Date of birth"
                                                description={`You must be at least ${MIN_SIGNUP_AGE_YEARS} years old.`}
                                                error={errorFor('dob')}
                                                required
                                            >
                                                <Input
                                                    ref={bindField('dob')}
                                                    type="date"
                                                    name="bday"
                                                    autoComplete="bday"
                                                    max={maxSignupDob}
                                                    value={dob}
                                                    onChange={(e) => {
                                                        setDob(e.target.value);
                                                        edited('dob');
                                                    }}
                                                    className="[&::-webkit-date-and-time-value]:text-left"
                                                />
                                            </Field>
                                            <Field label="Phone (optional)">
                                                <Input
                                                    type="tel"
                                                    name="tel"
                                                    inputMode="tel"
                                                    autoComplete="tel"
                                                    value={phoneNumber}
                                                    onChange={(e) => setPhoneNumber(e.target.value)}
                                                    placeholder="+1 555 123 4567"
                                                />
                                            </Field>
                                        </div>
                                        <div className="flex flex-col gap-3 pt-1">
                                            <div className="flex flex-col gap-1.5">
                                                <Checkbox
                                                    ref={bindField('terms')}
                                                    checked={termsAccepted}
                                                    onCheckedChange={(checked) => {
                                                        setTermsAccepted(checked);
                                                        edited('terms');
                                                    }}
                                                    required
                                                    aria-invalid={errorFor('terms') ? true : undefined}
                                                    aria-describedby={errorFor('terms') ? 'auth-terms-error' : undefined}
                                                    label={
                                                        <>
                                                            I accept the{' '}
                                                            <a href={TERMS_HREF} target="_blank" rel="noopener noreferrer" className={INLINE_LINK}>
                                                                Terms and Conditions<span className="sr-only"> (opens in a new tab)</span>
                                                            </a>{' '}
                                                            and the{' '}
                                                            <a href={PRIVACY_HREF} target="_blank" rel="noopener noreferrer" className={INLINE_LINK}>
                                                                Privacy Policy<span className="sr-only"> (opens in a new tab)</span>
                                                            </a>
                                                            .
                                                        </>
                                                    }
                                                />
                                                {errorFor('terms') ? (
                                                    <p id="auth-terms-error" className={cn('m-0 flex items-start gap-1.5 pl-[1.625rem] text-[length:var(--ds-text-sm)] font-medium leading-5', TONE_TEXT.danger)}>
                                                        <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                                                        <span>{errorFor('terms')}</span>
                                                    </p>
                                                ) : null}
                                            </div>
                                            <Checkbox
                                                checked={marketingConsent}
                                                onCheckedChange={setMarketingConsent}
                                                label="Send me marketing emails and updates (optional)."
                                            />
                                        </div>
                                    </>
                                ) : null}

                                {mode === 'signin' || mode === 'magic-link' ? (
                                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                                        <Checkbox checked={rememberMe} onCheckedChange={setRememberMe} label="Remember me" />
                                        {mode === 'signin' ? (
                                            <button type="button" onClick={() => goTo('forgot', { focusTitle: true })} className={TEXT_ACTION}>
                                                Forgot password?
                                            </button>
                                        ) : null}
                                    </div>
                                ) : null}

                                {turnstileEnabled() && (
                                    <div className="flex justify-center">
                                        <Turnstile onToken={setCaptchaToken} onExpire={() => setCaptchaToken('')} action={mode} />
                                    </div>
                                )}

                                <Button type="submit" size="lg" loading={isLoading} className={WIDE_BUTTON}>
                                    {submitLabel}
                                    {isLoading ? null : <ArrowRight aria-hidden="true" />}
                                </Button>

                                {mode === 'signin' ? (
                                    <>
                                        <OrDivider />
                                        <Button variant="outline" size="lg" className={WIDE_BUTTON} onClick={() => goTo('magic-link', { focusTitle: true })}>
                                            <Mail aria-hidden="true" />
                                            Email me a sign-in link
                                        </Button>
                                    </>
                                ) : null}
                                {mode === 'magic-link' ? (
                                    <>
                                        <OrDivider />
                                        <Button variant="outline" size="lg" className={WIDE_BUTTON} onClick={() => goTo('signin', { focusTitle: true })}>
                                            Sign in with a password
                                        </Button>
                                    </>
                                ) : null}
                                {mode === 'forgot' ? (
                                    <button type="button" onClick={() => goTo('signin', { focusTitle: true })} className={cn(TEXT_ACTION, 'self-center')}>
                                        Back to sign in
                                    </button>
                                ) : null}
                                {mode === 'signup' ? (
                                    <p className="m-0 border-t border-ds-hairline pt-6 text-sm text-ds-muted">
                                        Already have an account?{' '}
                                        <button type="button" onClick={() => goTo('signin', { focusTitle: true })} className={INLINE_LINK}>
                                            Sign in
                                        </button>
                                    </p>
                                ) : null}
                            </form>
                        )}

                        <footer className="mt-12 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ds-muted">
                            <span>© {year} DreamStream Studio</span>
                            <button type="button" onClick={onOpenTerms} className={FOOTER_ACTION}>
                                Terms
                            </button>
                            <button type="button" onClick={onOpenPrivacy} className={FOOTER_ACTION}>
                                Privacy
                            </button>
                        </footer>
                    </div>
                </section>

                <BrandPanel />
            </div>
        </div>
    );
};
