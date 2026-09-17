import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * Global search across all entities (users, heroes, teams, tournaments, events).
   * Results are grouped by type.
   * Empty or short queries return empty groups (no error).
   */
  @Get()
  search(@Query() query: SearchQueryDto) {
    return this.searchService.search(query);
  }
}
