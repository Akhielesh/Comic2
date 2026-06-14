import React from 'react';
import type { GameArtifact } from '../../../apiTypes';
import { SnakeGame } from './games/SnakeGame';
import { BreakoutGame } from './games/BreakoutGame';
import { Game2048 } from './games/Game2048';
import { MemoryGame } from './games/MemoryGame';

// One renderer for the `game` artifact type — picks the playable game from the
// payload's `game` discriminator. Each game owns its own GameShell (size +
// fullscreen), so this is a thin switch. Unknown ids fall back to Snake rather than
// rendering nothing.
export const GameCard: React.FC<{ data: GameArtifact }> = ({ data }) => {
  switch (data?.game) {
    case 'breakout':
      return <BreakoutGame difficulty={data.difficulty} />;
    case '2048':
      return <Game2048 />;
    case 'memory':
      return <MemoryGame difficulty={data.difficulty} />;
    case 'snake':
    default:
      return <SnakeGame difficulty={data?.difficulty} />;
  }
};
