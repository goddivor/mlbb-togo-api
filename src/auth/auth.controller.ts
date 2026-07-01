import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
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

  @Post('change-password')
  changePassword(@Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(dto);
  }

  /** Connexion MLBB : envoi du code de vérification dans le courrier en jeu. */
  @Post('mlbb/send-vc')
  mlbbSendVc(@Body() dto: MlbbSendVcDto) {
    return this.authService.mlbbSendVc(dto.roleId, dto.zoneId);
  }

  /** Connexion MLBB : validation du code + émission de notre JWT. */
  @Post('mlbb/login')
  mlbbLogin(@Body() dto: MlbbLoginDto) {
    return this.authService.mlbbLogin(dto.roleId, dto.zoneId, dto.vc);
  }

  /** Connexion via Google (access token Google Identity Services). */
  @Post('google')
  googleLogin(@Body() dto: GoogleLoginDto) {
    return this.authService.googleLogin(dto.accessToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { id: string }) {
    return this.authService.me(user.id);
  }

  /** Lie un compte de jeu MLBB au compte connecté (code de vérification). */
  @UseGuards(JwtAuthGuard)
  @Post('link/mlbb')
  linkMlbb(@CurrentUser() user: { id: string }, @Body() dto: MlbbLoginDto) {
    return this.authService.linkMlbb(user.id, dto.roleId, dto.zoneId, dto.vc);
  }

  /** Lie un compte Google au compte connecté. */
  @UseGuards(JwtAuthGuard)
  @Post('link/google')
  linkGoogle(@CurrentUser() user: { id: string }, @Body() dto: GoogleLoginDto) {
    return this.authService.linkGoogle(user.id, dto.accessToken);
  }

  /** Choisit la source du profil affiché (google | game). */
  @UseGuards(JwtAuthGuard)
  @Patch('profile-source')
  setProfileSource(@CurrentUser() user: { id: string }, @Body() dto: ProfileSourceDto) {
    return this.authService.setProfileSource(user.id, dto.source);
  }

  /** Resynchronise les données de jeu du compte connecté. */
  @UseGuards(JwtAuthGuard)
  @Post('sync-game')
  syncGame(@CurrentUser() user: { id: string }) {
    return this.authService.syncGame(user.id);
  }

  /** Dissocie le compte de jeu MLBB du compte connecté. */
  @UseGuards(JwtAuthGuard)
  @Post('unlink/mlbb')
  unlinkMlbb(@CurrentUser() user: { id: string }) {
    return this.authService.unlinkMlbb(user.id);
  }

  /** Héros favoris du compte connecté pour une saison donnée (sélecteur de saison). */
  @UseGuards(JwtAuthGuard)
  @Get('game/heroes')
  gameHeroes(@CurrentUser() user: { id: string }, @Query('sid') sid: string) {
    return this.authService.gameHeroes(user.id, Number(sid));
  }
}
