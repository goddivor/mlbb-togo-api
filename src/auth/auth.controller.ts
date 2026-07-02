import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AdminLoginDto } from './dto/admin-login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MlbbSendVcDto, MlbbLoginDto } from './dto/mlbb-login.dto';
import { GoogleLoginDto } from './dto/google.dto';
import { ProfileSourceDto } from './dto/profile-source.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('admin/login')
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.authService.adminLogin(dto);
  }

  @Post('change-password')
  changePassword(@Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(dto);
  }

  @Post('mlbb/send-vc')
  mlbbSendVc(@Body() dto: MlbbSendVcDto) {
    return this.authService.mlbbSendVc(dto.roleId, dto.zoneId);
  }

  @Post('mlbb/login')
  mlbbLogin(@Body() dto: MlbbLoginDto) {
    return this.authService.mlbbLogin(dto.roleId, dto.zoneId, dto.vc);
  }

  @Post('google')
  googleLogin(@Body() dto: GoogleLoginDto) {
    return this.authService.googleLogin(dto.accessToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { id: string }) {
    return this.authService.me(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('link/mlbb')
  linkMlbb(@CurrentUser() user: { id: string }, @Body() dto: MlbbLoginDto) {
    return this.authService.linkMlbb(user.id, dto.roleId, dto.zoneId, dto.vc);
  }

  @UseGuards(JwtAuthGuard)
  @Post('link/google')
  linkGoogle(@CurrentUser() user: { id: string }, @Body() dto: GoogleLoginDto) {
    return this.authService.linkGoogle(user.id, dto.accessToken);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile-source')
  setProfileSource(@CurrentUser() user: { id: string }, @Body() dto: ProfileSourceDto) {
    return this.authService.setProfileSource(user.id, dto.source);
  }

  @UseGuards(JwtAuthGuard)
  @Post('sync-game')
  syncGame(@CurrentUser() user: { id: string }) {
    return this.authService.syncGame(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('unlink/mlbb')
  unlinkMlbb(@CurrentUser() user: { id: string }) {
    return this.authService.unlinkMlbb(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('game/heroes')
  gameHeroes(@CurrentUser() user: { id: string }, @Query('sid') sid: string) {
    return this.authService.gameHeroes(user.id, Number(sid));
  }
}
