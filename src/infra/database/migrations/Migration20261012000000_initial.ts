import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As invariantes que importam ficam aqui, e não só no código:
 *
 * - saldo nunca negativo                  -> CHECK em wallets.balance
 * - uma wallet por player + moeda         -> UNIQUE (player_id, currency)
 * - idempotência                          -> UNIQUE (provider_id, idempotency_key)
 *                                            UNIQUE (provider_id, external_transaction_id)
 * - uma reversão por referência           -> UNIQUE parcial em reference_transaction_id
 * - um lançamento por transação/wallet    -> UNIQUE (transaction_id, wallet_id)
 * - lançamento com aritmética correta     -> CHECK balance_after = balance_before +- amount
 * - ledger encadeado e igual ao saldo     -> triggers (o último balance_after é o saldo)
 * - ledger imutável                       -> trigger bloqueando UPDATE/DELETE/TRUNCATE
 * - transação terminal imutável           -> trigger
 */
export class Migration20261012000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) not null check (balance >= 0),
        version     integer not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint uq_wallets_player_currency unique (player_id, currency),
        -- alvo da FK composta do ledger (garante moeda do lançamento = moeda da wallet)
        constraint uq_wallets_id_currency unique (id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                                uuid primary key,
        provider_id                       varchar(64) not null,
        external_transaction_id           varchar(128) not null,
        idempotency_key                   varchar(255) not null,
        payload_hash                      char(64) not null,
        wallet_id                         uuid not null references wallets (id),
        player_id                         uuid not null,
        round_id                          varchar(128) not null,
        game_id                           varchar(128) not null,
        kind                              varchar(16) not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            numeric(20, 2) not null check (amount > 0),
        currency                          char(3) not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid references wager_transactions (id),
        status                            varchar(24) not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      varchar(64),
        observed_balance                  numeric(20, 2),
        reference_attempts                integer not null default 0 check (reference_attempts >= 0),
        next_reference_check_at           timestamptz,
        created_at                        timestamptz not null,
        processed_at                      timestamptz,
        updated_at                        timestamptz not null,

        constraint uq_wager_tx_idempotency unique (provider_id, idempotency_key),
        constraint uq_wager_tx_external unique (provider_id, external_transaction_id),
        constraint ck_wager_tx_failure_code
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint ck_wager_tx_reversal_reference
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wager_tx_opening_internal
          check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint ck_wager_tx_pending_reference_schedule
          check (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null),
        constraint ck_wager_tx_terminal_timestamp
          check (status not in ('PROCESSED', 'REJECTED', 'FAILED') or processed_at is not null)
      );
    `);

    // A mesma referência não pode ser revertida duas vezes. Vale entre REFUND e
    // ROLLBACK também: um BET estornado por REFUND e depois por ROLLBACK
    // devolveria o valor em dobro.
    this.addSql(`
      create unique index uq_wager_tx_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    this.addSql(`
      create index ix_wager_tx_pending_reference_due
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index ix_wager_tx_waiting_reference
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index ix_wager_tx_reference on wager_transactions (reference_transaction_id);`);

    this.addSql(`
      create table wallet_ledger_entries (
        seq             bigint generated always as identity,
        id              uuid primary key,
        wallet_id       uuid not null,
        transaction_id  uuid not null references wager_transactions (id),
        direction       varchar(6) not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(20, 2) not null check (balance_before >= 0),
        balance_after   numeric(20, 2) not null check (balance_after >= 0),
        created_at      timestamptz not null,

        constraint uq_ledger_seq unique (seq),
        constraint uq_ledger_transaction_wallet unique (transaction_id, wallet_id),
        constraint fk_ledger_wallet_currency
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint ck_ledger_arithmetic check (
          balance_after = balance_before
            + case when direction = 'CREDIT' then amount else -amount end
        )
      );
    `);
    this.addSql(`create index ix_ledger_wallet_seq on wallet_ledger_entries (wallet_id, seq);`);

    // ---- ledger append-only
    this.addSql(`
      create function ledger_forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% blocked)', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger trg_ledger_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function ledger_forbid_mutation();
    `);
    this.addSql(`
      create trigger trg_ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function ledger_forbid_mutation();
    `);

    // ---- ledger encadeado: balance_before do novo lançamento = balance_after do anterior
    this.addSql(`
      create function ledger_check_chain() returns trigger language plpgsql as $$
      declare
        previous numeric(20, 2);
      begin
        select balance_after into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by seq desc
         limit 1;

        if coalesce(previous, 0) <> new.balance_before then
          raise exception 'ledger chain broken for wallet %: expected balance_before %, got %',
            new.wallet_id, coalesce(previous, 0), new.balance_before
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger trg_ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function ledger_check_chain();
    `);

    // ---- saldo materializado = último balance_after do ledger.
    // Deferido pro commit: dentro da transação a ordem é insere lançamento,
    // atualiza wallet, e só no final os dois precisam bater.
    this.addSql(`
      create function wallet_balance_matches_ledger(target_wallet uuid) returns void language plpgsql as $$
      declare
        stored numeric(20, 2);
        last_after numeric(20, 2);
      begin
        select balance into stored from wallets where id = target_wallet;
        select balance_after into last_after
          from wallet_ledger_entries
         where wallet_id = target_wallet
         order by seq desc
         limit 1;

        if stored is distinct from coalesce(last_after, 0) then
          raise exception 'wallet % balance % does not match ledger %',
            target_wallet, stored, coalesce(last_after, 0)
            using errcode = 'check_violation';
        end if;
      end;
      $$;
    `);
    this.addSql(`
      create function trg_wallet_balance_check() returns trigger language plpgsql as $$
      begin
        perform wallet_balance_matches_ledger(new.id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create function trg_ledger_balance_check() returns trigger language plpgsql as $$
      begin
        perform wallet_balance_matches_ledger(new.wallet_id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger trg_wallet_matches_ledger
        after insert or update of balance on wallets
        deferrable initially deferred
        for each row execute function trg_wallet_balance_check();
    `);
    this.addSql(`
      create constraint trigger trg_ledger_matches_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function trg_ledger_balance_check();
    `);

    // ---- transação em estado terminal não muda mais
    this.addSql(`
      create function wager_tx_guard_terminal() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transactions cannot be deleted' using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if (new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.kind, new.amount, new.currency)
           is distinct from
           (old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.kind, old.amount, old.currency) then
          raise exception 'business fields of wager transaction % are immutable', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger trg_wager_tx_guard
        before update or delete on wager_transactions
        for each row execute function wager_tx_guard_terminal();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name  varchar(64) not null,
        message_id     varchar(128) not null,
        payload_hash   char(64) not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     uuid not null,
        event_type       varchar(64) not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text
      );
    `);
    this.addSql(`
      create index ix_outbox_due on outbox_messages (next_attempt_at) where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists wager_tx_guard_terminal();`);
    this.addSql(`drop function if exists trg_ledger_balance_check();`);
    this.addSql(`drop function if exists trg_wallet_balance_check();`);
    this.addSql(`drop function if exists wallet_balance_matches_ledger(uuid);`);
    this.addSql(`drop function if exists ledger_check_chain();`);
    this.addSql(`drop function if exists ledger_forbid_mutation();`);
  }
}
