import { userFacingErrorMessage } from '../../../services/apiErrors';
import type { ComicDoc } from '../../../shared/comic/doc';
import { streamStudio, toStudioApiError } from '../studioApi';
import { begin, end, event, studioStreamKey } from './studioStreams';

/** Called by the creator's explicit submit. The studio adopts this stream when it opens. */
export function startDirectorDraft(accountId: string, doc: ComicDoc): void {
  const intent = doc.directorDraft;
  if (intent?.status !== 'ready') return;

  const key = studioStreamKey(accountId, doc.id);
  const action = { type: 'start_director_draft' as const, idea: intent.idea, expectedRev: doc.rev };
  const streamId = `director-draft-${doc.rev}`;
  const ctrl = new AbortController();
  begin(key, { streamId, kind: 'action', actionType: action.type, ctrl, before: doc });
  void streamStudio(doc.id, { kind: 'action', action }, message => event(key, streamId, message), ctrl.signal)
    .then(() => end(key, streamId))
    .catch(cause => {
      const error = toStudioApiError(cause, 'project');
      end(key, streamId, { aborted: ctrl.signal.aborted, error: userFacingErrorMessage(error, 'The director could not start this draft. Your idea is saved.'), code: error.code, lost: error.kind === 'connection_lost' });
    });
}
