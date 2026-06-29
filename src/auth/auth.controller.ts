import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MlbbSendVcDto, MlbbLoginDto } from './dto/mlbb-login.dto';
import { GoogleLoginDto } from './dto/google.dto';
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
}
