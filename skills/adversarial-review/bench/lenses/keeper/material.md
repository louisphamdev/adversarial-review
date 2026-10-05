# Release note for migration 0042

## Scope

The partner record keeps one free-text `address`. Reporting needs `street` and `city`
as separate columns. The partner tier moves to a code column named `tier_code`, and
invoices keep a copy of the tier at invoice time.

## Affected tables

- `partners`: about 240 000 rows in production.
- `partner_tiers`: 5 rows, a lookup table.
- `invoices`: about 9 million rows.

## Application versions

- Build 7.3 reads `partners.address` and `partners.tier`.
- Build 7.4 reads `partners.street`, `partners.city`, and `partners.tier_code`.
- Build 7.3 stays on two of the six web nodes during the rollout window.

## Window

The migration runs at 02:00 UTC. The write load at that hour is about 40 inserts a
second on `invoices`. The maintenance window is 15 minutes long.

## Rollback

Operations run the down migration in the same file. No backup of `partners` is taken
before the up migration, because the window is short.

## Open points

- Nobody has measured how long the index build takes on 240 000 rows.
- The report team has not confirmed the `split_part` separator.
