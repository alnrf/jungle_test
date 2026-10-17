import { z } from "zod";
import { DomainError } from "../shared/domain/errors";
import { INTERNAL_PROVIDER_ID } from "../wagering/domain/wager-transaction";

export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

const externalId = z.string().trim().min(1).max(128);

// formato do amount é validado pelo Money (mesma regra em todo lugar)
export const moneySchema = z.object({ amount: z.string(), currency: z.string() });

export const wagerPayloadSchema = z.object({
  providerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/, "invalid providerId")
    .refine((v) => v !== INTERNAL_PROVIDER_ID, "providerId is reserved"),
  externalTransactionId: externalId,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: externalId,
  gameId: externalId,
  // OPENING fica de fora: é interno
  kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  money: moneySchema,
  referenceExternalTransactionId: externalId.optional(),
});

export type WagerPayloadInput = z.infer<typeof wagerPayloadSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7E]+$/, "idempotency key must be printable ASCII without spaces");

export const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime(),
  correlationId: z.string().min(1).max(128).optional(),
  data: wagerPayloadSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export const createWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});

export const ledgerQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const uuidParam = z.uuid();

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      "invalid request",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
