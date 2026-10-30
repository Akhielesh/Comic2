// Where the floating Universal Assistant appears. It is not mounted on the full-screen chat product (two stacked chat
// surfaces), the v4 Comic Studio (itself a conversation with the Comic Director), the shared viewer or the auth
// callback. In the reader it stays mounted but its launcher is hidden: the launcher sat over the art (and over the
// reading mode's notes) on phones.
export interface AssistantChrome {
  mounted: boolean;
  hideLauncher: boolean;
}

const NOT_MOUNTED = new Set(['auth-callback', 'shared', 'chat', 'comicstudio']);

export const assistantChrome = (view: string): AssistantChrome => ({
  mounted: !NOT_MOUNTED.has(view),
  hideLauncher: view === 'reader'
});
