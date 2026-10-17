import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env";

/**
 * Quanto tempo uma transação espera pela referência.
 *
 * Padrão: 8 tentativas, começando em 2s e dobrando até 5min.
 * 2+4+8+16+32+64+128 = ~4min até desistir. Provedor que manda o
 * ROLLBACK antes do BET normalmente manda o BET em segundos; se depois de
 * alguns minutos não chegou, o mais provável é que nunca vá chegar.
 */
@Injectable()
export class ReferenceRetryPolicy {
  constructor(@Inject(ENV) private readonly env: Env) {}

  nextCheckAt(attempts: number, now: Date): Date {
    const delay = Math.min(
      this.env.PENDING_REFERENCE_BASE_DELAY_MS * 2 ** attempts,
      this.env.PENDING_REFERENCE_MAX_DELAY_MS,
    );
    return new Date(now.getTime() + delay);
  }

  /** `attempts` = quantas verificações já falharam antes desta. */
  shouldGiveUp(attempts: number): boolean {
    return attempts + 1 >= this.env.PENDING_REFERENCE_MAX_ATTEMPTS;
  }
}
