import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService } from './ai.service';
import { CounterPicksDto, LangQueryDto, RecommendBuildDto, RecommendHeroesDto } from './dto/ai.dto';
import { AiLang } from './ai.types';

// The User model has no language preference yet: default to French (site default).
const langOf = (q: LangQueryDto): AiLang => q.lang ?? 'fr';

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status() {
    return this.ai.getStatus();
  }

  @UseGuards(JwtAuthGuard)
  @Post('coach')
  coach(@CurrentUser() user: { id: string }, @Query() q: LangQueryDto) {
    return this.ai.coach(user.id, langOf(q));
  }

  @UseGuards(JwtAuthGuard)
  @Post('recommend/heroes')
  recommendHeroes(
    @CurrentUser() user: { id: string },
    @Query() q: LangQueryDto,
    @Body() dto: RecommendHeroesDto,
  ) {
    return this.ai.recommendHeroes(user.id, dto.role, dto.lane, langOf(q));
  }

  @UseGuards(JwtAuthGuard)
  @Post('recommend/build')
  recommendBuild(
    @CurrentUser() user: { id: string },
    @Query() q: LangQueryDto,
    @Body() dto: RecommendBuildDto,
  ) {
    return this.ai.recommendBuild(user.id, dto.heroId, langOf(q));
  }

  @UseGuards(JwtAuthGuard)
  @Post('counter')
  counter(@CurrentUser() user: { id: string }, @Query() q: LangQueryDto, @Body() dto: CounterPicksDto) {
    return this.ai.counterPicks(user.id, dto.heroIds, langOf(q));
  }

  @UseGuards(JwtAuthGuard)
  @Post('analyze')
  analyze(@CurrentUser() user: { id: string }, @Query() q: LangQueryDto) {
    return this.ai.analyze(user.id, langOf(q));
  }
}
