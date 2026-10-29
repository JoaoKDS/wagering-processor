-- Reverte 0001_init, na ordem inversa das dependências.
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TRIGGER IF EXISTS wallet_ledger_no_update_delete ON wallet_ledger_entries;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP FUNCTION IF EXISTS wallet_ledger_append_only();
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
