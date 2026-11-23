import React, { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from './ds/Dialog';
import { PrivacyPolicy } from './PrivacyPolicy';
import { TermsOfService } from './TermsOfService';

export function SignupLegalPreview() {
  const [document, setDocument] = useState<'terms' | 'privacy' | null>(null);
  const opener = useRef<HTMLAnchorElement>(null);
  function show(event: React.MouseEvent<HTMLAnchorElement>, page: 'terms' | 'privacy') {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    opener.current = event.currentTarget;
    setDocument(page);
  }
  return <>
    <span>I accept the <a className="underline" href="/?view=terms" onClick={event => show(event, 'terms')}>Terms and Conditions</a> and <a className="underline" href="/?view=privacy" onClick={event => show(event, 'privacy')}>Privacy Policy</a>.</span>
    <Dialog open={Boolean(document)} onOpenChange={open => { if (!open) setDocument(null); }}>
      <DialogContent size="lg" aria-describedby={undefined} closeLabel="Return to signup" onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
        <DialogTitle className="sr-only">{document === 'terms' ? 'Terms and Conditions' : 'Privacy Policy'}</DialogTitle>
        {document === 'terms' ? <TermsOfService /> : <PrivacyPolicy />}
      </DialogContent>
    </Dialog>
  </>;
}
