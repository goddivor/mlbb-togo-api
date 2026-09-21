import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { RolesController } from './roles.controller';

/** RBAC: roles, permissions and their enforcement helpers (global). */
@Global()
@Module({
  controllers: [RolesController],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
