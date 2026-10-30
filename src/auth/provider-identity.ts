import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { PROVIDER_IDENTITY } from "../tokens";

/**
 * Ponto de extensão da autenticação (spec, seção 2).
 * - `null` como resultado: não autenticado (401).
 * - `providerId: null`: autenticação desligada (modo de desenvolvimento). Nenhuma checagem de provedor.
 * - `providerId` preenchido: provedor autenticado. Corpo e rota precisam bater com ele (403 se não).
 */
export interface ProviderIdentityPort {
  authenticate(headers: Record<string, string | undefined>): Promise<{ providerId: string | null } | null>;
}

/** Modo de desenvolvimento (AUTH_MODE != jwt): aceita tudo e não identifica o provedor. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<{ providerId: string | null } | null> {
    return { providerId: null };
  }
}

export interface JwtIdentityOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** Para testes: JWKS local em vez de URL remota. */
  jwks?: JWTVerifyGetKey;
}

/**
 * Valida o token do Keycloak: assinatura (JWKS), emissor, audiência e expiração.
 * O providerId vem do claim `provider_id`, que o realm grava a partir do atributo do usuário.
 */
export class JwtProviderIdentity implements ProviderIdentityPort {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: JwtIdentityOptions) {
    this.keys = options.jwks ?? createRemoteJWKSet(new URL(options.jwksUrl));
  }

  async authenticate(headers: Record<string, string | undefined>): Promise<{ providerId: string | null } | null> {
    const header = headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
      });
      if (typeof payload.provider_id !== "string" || payload.provider_id === "") return null;
      return { providerId: payload.provider_id };
    } catch {
      return null;
    }
  }
}

/** Guard aplicado às rotas de negócio. Health e métricas ficam abertos. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      body?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }>();
    const identity = await this.identity.authenticate(req.headers);
    if (!identity) throw new UnauthorizedException({ code: "UNAUTHORIZED" });

    if (identity.providerId !== null) {
      // O provedor autenticado só pode agir sobre os próprios dados (corpo e rota).
      const claimed = [req.body?.providerId, req.params?.providerId].filter(
        (value): value is string => typeof value === "string",
      );
      if (claimed.some((value) => value !== identity.providerId)) {
        throw new ForbiddenException({ code: "PROVIDER_MISMATCH" });
      }
    }
    return true;
  }
}
