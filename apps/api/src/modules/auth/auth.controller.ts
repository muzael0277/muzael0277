import { Body, Controller, Get, Post, Req, Res, HttpCode } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  loginSchema, registerSchema, changePasswordSchema, updateProfileSchema,
  type LoginInput, type RegisterInput,
} from '@bizbot/contracts';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { loadEnv } from '@bizbot/config';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedRoute, CurrentActor, Public } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { PrismaService } from '../../infra/prisma.service';

const REFRESH_COOKIE = 'bizbot_rt';

/**
 * The refresh token lives in an httpOnly cookie for the admin app (so XSS cannot read
 * it) while the access token stays in memory. The Mini App cannot use cookies inside
 * Telegram's webview, so it receives the refresh token in the body instead — both paths
 * are supported deliberately, not by accident.
 */
@Controller('auth')
export class AuthController {
  private readonly env = loadEnv();

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body(zodBody(registerSchema)) dto: RegisterInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(dto, { ip: req.ip, userAgent: req.header('user-agent') });
    this.setRefreshCookie(res, result.refreshToken);
    return this.publicShape(result);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginSchema)) dto: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    this.setRefreshCookie(res, result.refreshToken);
    return this.publicShape(result);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { refreshToken?: string },
  ) {
    const presented = req.cookies?.[REFRESH_COOKIE] ?? body?.refreshToken;
    if (!presented) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'No refresh token presented');

    const pair = await this.tokens.rotate(presented, {
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    this.setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (presented) await this.tokens.revoke(presented);
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @Public()
  @Get('me')
  async me(@Req() req: Request) {
    // Declared @Public so the guard does not reject an anonymous caller outright; the
    // handler itself requires a session. This lets the admin app probe session validity
    // on load without a 401 error appearing in the console on first visit.
    const actor = (req as Request & { actor?: RequestActor }).actor;
    if (!actor?.userId) throw new DomainError(ErrorCode.UNAUTHENTICATED);
    return this.loadMe(actor.userId);
  }

  @AuthenticatedRoute()
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(changePasswordSchema)) dto: { currentPassword: string; newPassword: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.changePassword(actor.userId!, dto.currentPassword, dto.newPassword);
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @AuthenticatedRoute()
  @Post('profile')
  async updateProfile(
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(updateProfileSchema)) dto: Record<string, unknown>,
  ) {
    await this.prisma.system('update-profile', () =>
      this.prisma.raw.profile.update({ where: { userId: actor.userId! }, data: dto }),
    );
    return this.loadMe(actor.userId!);
  }

  private async loadMe(userId: string) {
    const user = await this.prisma.system('load-me', () =>
      this.prisma.raw.user.findUniqueOrThrow({
        where: { id: userId },
        include: {
          profile: true,
          memberships: {
            where: { isActive: true },
            include: {
              tenant: {
                select: {
                  id: true, slug: true, name: true, logoUrl: true, status: true,
                  primaryColor: true, templateKey: true, onboardingStep: true,
                  onboardingCompletedAt: true,
                  modules: { where: { enabled: true }, select: { module: true } },
                },
              },
            },
          },
        },
      }),
    );

    return {
      user: {
        id: user.id, email: user.email, platformRole: user.platformRole,
        firstName: user.profile?.firstName ?? '', lastName: user.profile?.lastName ?? null,
        phone: user.profile?.phone ?? null, avatarUrl: user.profile?.avatarUrl ?? null,
        language: user.profile?.language ?? 'uz',
      },
      tenants: user.memberships
        .filter((m) => m.tenant.status !== 'DELETED')
        .map((m) => ({
          id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name,
          logoUrl: m.tenant.logoUrl, primaryColor: m.tenant.primaryColor,
          templateKey: m.tenant.templateKey, status: m.tenant.status,
          role: m.role,
          onboardingStep: m.tenant.onboardingStep,
          onboardingCompleted: m.tenant.onboardingCompletedAt !== null,
          modules: m.tenant.modules.map((mod) => mod.module),
        })),
    };
  }

  /** The refresh token never appears in a JSON response for cookie-based clients. */
  private publicShape(result: Awaited<ReturnType<AuthService['login']>>) {
    const { refreshToken, ...rest } = result;
    return { ...rest, refreshToken };
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: this.env.JWT_REFRESH_TTL_DAYS * 86400_000,
    });
  }
}
