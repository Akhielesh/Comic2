// ============================================================================
// Google Drive — save recordings (per-user OAuth, WRITE via drive.file only)
// ============================================================================
// Stream Studio uploads finished recordings into a "DreamStream Recordings" folder in
// the user's own Drive. Deliberately a SEPARATE connector from the read-only
// `google_drive` one so connecting it asks for exactly one Drive permission:
//
//   drive.file — "see, edit, create and delete only the specific Google Drive files
//                you use with this app". The app can see the files/folder it creates
//                and NOTHING else in the user's Drive. Non-restricted (no CASA
//                security assessment), unlike drive / drive.readonly.
//
// It never syncs or indexes anything: the only operation is opening a resumable
// upload session (routes/connectorsDrive.ts → connectors/driveSave.ts). Recording
// bytes go browser → Google directly; they never pass through our backend.
// ============================================================================

import { GoogleOAuthConnector } from '../base.js';
import type { ConnectorMetadata, FetchInput, NormalizedItem, SyncResult } from '../types.js';

export const DRIVE_SAVE_CONNECTOR_ID = 'google_drive_save';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** The full-Drive scope also permits creating files (if a user ever granted it). */
const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

export class GoogleDriveSaveConnector extends GoogleOAuthConnector {
  readonly metadata: ConnectorMetadata = {
    id: DRIVE_SAVE_CONNECTOR_ID,
    displayName: 'Google Drive — save recordings',
    description:
      'Stream Studio saves finished recordings to a “DreamStream Recordings” folder in your Drive. It can only see files it saves — never the rest of your Drive.',
    icon: 'HardDrive',
    category: 'storage',
    authType: 'user_oauth',
    providerGroup: 'google',
    requiredScopes: [
      DRIVE_FILE_SCOPE,
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    // Upload-only: nothing to sync, search or index.
    capabilities: { searchable: false, syncable: false, realtime: false, apiKeyBased: false },
    docsUrl: 'https://developers.google.com/drive/api/guides/manage-uploads#resumable'
  };

  /**
   * Whether a connection's granted scopes allow creating files. Google's granular consent
   * lets a user untick drive.file while still approving email/profile — such a grant
   * "connects" but can't save anything, so it must be sent back to reconnect.
   */
  static hasWriteScope(grantedScopes: string[] | null | undefined): boolean {
    const granted = grantedScopes || [];
    return granted.includes(DRIVE_FILE_SCOPE) || granted.includes(DRIVE_FULL_SCOPE);
  }

  async syncFull(): Promise<SyncResult> {
    return { items: [], cursor: {}, hasMore: false };
  }

  async syncIncremental(): Promise<SyncResult> {
    return { items: [], cursor: {}, hasMore: false };
  }

  async fetch(input: FetchInput): Promise<unknown> {
    throw new Error(
      `Google Drive (save recordings) is upload-only — "${input.resource}" is not readable. Use POST /api/connectors/drive/upload-session.`
    );
  }

  normalize(): NormalizedItem[] {
    return [];
  }
}
