import { createContext, useContext } from 'react';
import type { ChatArtifact } from '../../apiTypes';

/** Opens a rich artifact (map, etc.) in the chat's resizable side panel. */
export type ChatPanelOpener = (artifact: ChatArtifact) => void;

export const ChatPanelContext = createContext<ChatPanelOpener | null>(null);

export const useChatPanel = (): ChatPanelOpener | null => useContext(ChatPanelContext);
