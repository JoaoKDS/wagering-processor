import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { PROVIDER_IDENTITY } from "../tokens";

/**
 * Ponto de extensão da autenticação (spec, seção 2).
 * Retorna o providerId autenticado, ou null se a identidade não for válida.
 * A produção deve validar tokens do Keycloak ou Zitadel aqui.
 */
export interface ProviderIdentityPort {
  authenticate(headers: Record<string, string | undefined>): Promise<{ providerId: string } | null>;
}

/**
 * Implementação atual: aceita todas as requisições. A autenticação não vale pontos na spec,
 * e este é o ponto de extensão documentado no ARCHITECTURE.md.
 */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<{ providerId: string } | null> {
    return { providerId: "unauthenticated" };
  }
}

/** Guard aplicado às rotas de negócio. Health e métricas ficam abertos. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const identity = await this.identity.authenticate(req.headers);
    if (!identity) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
    return true;
  }
}
