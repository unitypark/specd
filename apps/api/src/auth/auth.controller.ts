import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service.js';
import { Config } from '../config.js';
import { CliAllowed, Public } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { TokenClaims } from './auth.service.js';

class RegisterDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(8) password!: string;
}

class LoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
}

class DevicePollDto {
  @IsString() deviceCode!: string;
}

class DeviceApproveDto {
  @IsString() userCode!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: Config,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const user = await this.auth.register(dto);
    const token = await this.auth.issueToken(user, 'web', '7d');
    return { user, token };
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    const user = await this.auth.login(dto.email, dto.password);
    const token = await this.auth.issueToken(user, 'web', '7d');
    return { user, token };
  }

  @Get('me')
  @CliAllowed()
  me(@CurrentUser() user: TokenClaims) {
    return {
      id: user.sub,
      email: user.email,
      name: user.name,
      audience: user.aud,
      // The CLI cannot derive this: the web app and the API are different
      // origins, so `specd open` has to be told where the app is.
      webOrigin: this.config.webOrigin,
    };
  }

  // ─── CLI device flow ────────────────────────────────────────────────────────

  @Public()
  @Post('device/start')
  startDevice() {
    return this.auth.startDeviceFlow();
  }

  @Public()
  @Post('device/poll')
  async pollDevice(@Body() dto: DevicePollDto) {
    const result = await this.auth.pollDeviceCode(dto.deviceCode);
    return result ?? { pending: true };
  }

  /** Called from the browser, by a signed-in human. That is the whole point. */
  @Post('device/approve')
  async approveDevice(@Body() dto: DeviceApproveDto, @CurrentUser() user: TokenClaims) {
    await this.auth.approveDeviceCode(dto.userCode, {
      id: user.sub,
      email: user.email,
      name: user.name,
    });
    return { ok: true };
  }
}
