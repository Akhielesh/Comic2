// Only first-party workspace destinations can be embedded in authentication callbacks.
export const AUTH_WORKSPACE_PATHS = {
  images: '/?view=images',
  chat: '/?view=chat',
  voice: '/?view=chat&voice=1',
} as const;

export type AuthWorkspace = keyof typeof AUTH_WORKSPACE_PATHS;

export const authWorkspace = (value: unknown): AuthWorkspace | undefined =>
  value === 'images' || value === 'chat' || value === 'voice' ? value : undefined;
