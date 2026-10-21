// The account ⇄ studio access contract (GET /api/account/studios), shared by the
// server and both apps so they can never disagree about who can use what.

export type StudioId = 'comic_studio' | 'chat_studio' | 'stream_studio' | 'baby_monitor' | 'code_studio';
/** open = use it now · needs_code = one step (welcome code) · locked = ask an admin · retiring = admin preview, going away */
export type StudioStatus = 'open' | 'needs_code' | 'locked' | 'retiring';

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
  account: { id: string; email: string | null; name: string | null; since: string | null; plan: string | null; admin: boolean };
  /** True when an admin confined this account to particular studios. */
  confined: boolean;
  studios: StudioAccess[];
}
