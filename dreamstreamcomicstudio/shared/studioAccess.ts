// The account ⇄ studio access contract (GET /api/account/studios), shared by the
// server and both apps so they can never disagree about who can use what.

export type StudioId = 'comic_studio' | 'chat_studio' | 'stream_studio' | 'baby_monitor';
/** open = use it now · needs_code = one step (welcome code) · locked = ask an admin */
export type StudioStatus = 'open' | 'needs_code' | 'locked';

export interface StudioAccess {
  id: StudioId;
  label: string;
  tagline: string;
  status: StudioStatus;
  /** One short line: why, or what you have there. */
  detail: string;
  /** Where the studio lives. */
  href: string;
  /** The one thing to do when it isn't open. */
  action?: { label: string; href: string };
}

export interface AccountAccess {
  account: {
    id: string;
    email: string | null;
    /** The one display name every studio shows (shared/accountName.ts resolveName). */
    name: string | null;
    /** The @handle — sign-in and Comic Studio identity; never the display name. */
    username: string | null;
    since: string | null;
    plan: string | null;
    admin: boolean;
  };
  /** True when an admin confined this account to particular studios. */
  confined: boolean;
  studios: StudioAccess[];
}
