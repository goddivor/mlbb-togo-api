import { Module } from '@nestjs/common';
import { MoontonClient } from './moonton.client';
import { BattlereportSource, GAME_DATA_SOURCE } from './game-data.source';
import { GameSyncService } from './game-sync.service';
import { GameService } from './game.service';
import { GameController } from './game.controller';

@Module({
  controllers: [GameController],
  providers: [
    MoontonClient,
    BattlereportSource,
    // Swap this binding when Moonton publishes replacement battle report routes.
    { provide: GAME_DATA_SOURCE, useExisting: BattlereportSource },
    GameSyncService,
    GameService,
  ],
  exports: [MoontonClient, GameSyncService, GameService],
})
export class GameModule {}
