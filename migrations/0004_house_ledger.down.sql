-- Reverte 0004_house_ledger.
DROP TRIGGER IF EXISTS house_ledger_no_update_delete ON house_ledger_entries;
DROP TABLE IF EXISTS house_ledger_entries;
DROP FUNCTION IF EXISTS house_ledger_append_only();
