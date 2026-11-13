// Phone portrait chrome (the 'single' layout): a 44 px header and a 52 px tab bar (their controls stay
// 44 px), so the board and the message list keep >= 45 % of an iPhone's height under the notch and the
// home indicator (P1-QA phone-content; visualqa P1-6). Short landscape also uses 44 px; the
// desktop workspace overrides the global header token with 48 px.
//
// The values are custom properties set on an element, so only that element's subtree reads them. Each
// surface that draws or offsets by the phone header / tab bar applies them itself: the studio shell
// root, the loading skeleton (so the header does not jump when the comic arrives) and the savings
// toast, which is portalled to <body>, outside the shell. (Moving them into index.css's
// `(max-width: 599px)` token block would make these per-surface styles unnecessary.)
import type React from 'react';
import type { StudioLayout } from '../formFactor';

export const PHONE_HEADER_PX = 44;
export const PHONE_TABBAR_PX = 52;

const VARS = { '--header-h': `${PHONE_HEADER_PX}px`, '--tabbar-h': `${PHONE_TABBAR_PX}px` } as React.CSSProperties;

/** Keep the project header slim while retaining 44 px controls, including short landscape. */
export const phoneChromeVars = (layout: StudioLayout): React.CSSProperties => layout === 'single'
  ? VARS
  : { '--header-h': layout === 'single-rail' ? '44px' : '48px' } as React.CSSProperties;
