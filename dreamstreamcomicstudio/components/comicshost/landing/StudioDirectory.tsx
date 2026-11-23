import React from 'react';
import { AUTH_WORKSPACE_PATHS } from '../../../shared/authWorkspace';
import { ArrowRight } from 'lucide-react';
import { DENSITY, FOCUS_RING, FONT_DISPLAY } from '../../chat/studioDesign';
import { cn } from '../../../lib/utils';
import { LIBRARY_HREF } from './ReadSection';
import './studioDirectory.css';

export interface StudioDirectoryProps {
  signedIn: boolean;
  onSignIn: () => void;
  onStartCreating?: () => void;
  onOpenComics: () => void;
  onBrowseGallery: () => void;
}

export function StudioDirectory({ signedIn, onSignIn, onStartCreating, onOpenComics, onBrowseGallery }: StudioDirectoryProps) {
  const actionClass = cn('studio-directory-action', DENSITY.coarse, FOCUS_RING);
  return (
    <section id="workspaces" className="studio-directory" aria-labelledby="studio-directory-title">
      <h3 id="studio-directory-title" tabIndex={-1} className={cn('studio-directory-title', FONT_DISPLAY)}>Find your workspace</h3>
      <ul className="studio-directory-list">
        <li>
          <h4>Comic Director</h4>
          <p>Start with an idea or script. Review the cast and page plan before you draw.</p>
          <button type="button" className={actionClass} onClick={signedIn ? (onStartCreating ?? onOpenComics) : onSignIn}>
            {signedIn ? 'Start a comic' : 'Sign in to create'} <ArrowRight aria-hidden />
          </button>
        </li>
        <li>
          <h4>Standalone images</h4>
          <p>Draw an illustration from a prompt. Add references for the subject, composition or style.</p>
          <a className={actionClass} href="/?view=images">{signedIn ? 'Open image workspace' : 'Sign in to draw'} <ArrowRight aria-hidden /></a>
        </li>
        <li>
          <h4>Chat with the assistant</h4>
          <p>Ask a question or talk through an idea. You can start a conversation without opening a project.</p>
          <div className="studio-directory-chat-actions">
            <a className={actionClass} href={AUTH_WORKSPACE_PATHS.chat}>Start a chat <ArrowRight aria-hidden /></a>
            <a className={actionClass} href={AUTH_WORKSPACE_PATHS.voice}>Talk by voice <ArrowRight aria-hidden /></a>
          </div>
        </li>
        <li>
          <h4>Page editor</h4>
          <p>Choose a comic to revise its artwork, lettering or sharing settings.</p>
          <button type="button" className={actionClass} onClick={signedIn ? onOpenComics : onSignIn}>
            {signedIn ? 'Choose a project' : 'Sign in to edit'} <ArrowRight aria-hidden />
          </button>
        </li>
        <li>
          <h4>Public Library</h4>
          <p>Read published comics in your browser, page by page.</p>
          <a className={actionClass} href={LIBRARY_HREF} onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault();
            onBrowseGallery();
          }}>
            Browse published comics <ArrowRight aria-hidden />
          </a>
        </li>
      </ul>
    </section>
  );
}
