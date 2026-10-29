// Phone portrait chrome (the 'single' layout): a 44 px header and a 52 px tab bar (their controls stay
// 44 px), so the board and the message list keep >= 45 % of an iPhone's height under the notch and the
// home indicator (P1-QA phone-content; visualqa P1-6). index.css's :root values (48 / 56 px) still
// apply everywhere else.
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

/** The custom properties for this layout's chrome: the phone portrait sizes, else none (index.css). */
export const phoneChromeVars = (layout: StudioLayout): React.CSSProperties | undefined => (layout === 'single' ? VARS : undefined);
