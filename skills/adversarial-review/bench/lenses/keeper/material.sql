-- Migration 0042: split the partner address and move the tier to its own table.

ALTER TABLE partners DROP COLUMN address;
ALTER TABLE partners ADD COLUMN street TEXT;
ALTER TABLE partners ADD COLUMN city TEXT;
UPDATE partners SET street = split_part(address, ',', 1);

ALTER TABLE partners ADD COLUMN contract_no TEXT NOT NULL;

UPDATE partners SET tier = 'gold' WHERE volume > 1000;
UPDATE partner_tiers SET label = 'Gold' WHERE code = 'gold';

ALTER TABLE partners RENAME COLUMN tier TO tier_code;

CREATE INDEX idx_partners_city ON partners (city);

ALTER TABLE invoices ADD COLUMN partner_tier TEXT;
UPDATE invoices
   SET partner_tier = p.tier_code
  FROM partners p
 WHERE p.id = invoices.partner_id;

-- Down migration

ALTER TABLE partners DROP COLUMN street;
ALTER TABLE partners DROP COLUMN city;
ALTER TABLE partners DROP COLUMN contract_no;
ALTER TABLE partners RENAME COLUMN tier_code TO tier;
DROP INDEX idx_partners_city;
ALTER TABLE invoices DROP COLUMN partner_tier;

-- Deployment order
-- 1. apply this file
-- 2. deploy the application build that reads tier_code
-- 3. no verification step is listed here
