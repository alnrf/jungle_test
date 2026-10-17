import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";

/**
 * Ponto de extensão da autenticação. Ver "Autenticação" no ARCHITECTURE.md.
 *
 * A implementação real validaria um JWT emitido pelo IdP (Keycloak, client
 * credentials por provedor) e devolveria o providerId do token. Hoje não
 * tem IdP no compose, então a implementação padrão não autentica ninguém.
 */
export interface ProviderIdentity {
  providerId: string;
}

export abstract class ProviderIdentityPort {
  /** undefined = requisição sem identidade (só aceito enquanto a auth está desligada). */
  abstract resolve(request: Request): Promise<ProviderIdentity | undefined>;
}

export class NoAuthProviderIdentity extends ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}

export type AuthenticatedRequest = Request & { providerIdentity?: ProviderIdentity };

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.providerIdentity = await this.identity.resolve(request);
    // com IdP de verdade: sem identidade -> 401 aqui
    return true;
  }
}
