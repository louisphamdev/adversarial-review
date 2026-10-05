# Payout export service - specification v4

## 1. Requirements

| ID | Requirement |
|---|---|
| R1 | The service exports one payout file per partner each day. |
| R2 | A failed upload is retried. |
| R3 | The operator can replay one day on demand. |
| R4 | Every payout row carries the settlement window it belongs to. |
| R5 | The operator is alerted when a partner export fails. |

## 2. Upload

The service uploads the file over SFTP. The connect timeout is 30 s. The service
retries a failed upload 3 times with a fixed pause of 10 s.

Each row carries `partnerId`, `amount`, and `currency`. `currency` is mandatory.

## 3. File layout

One header line, then one line per payout. The header names the columns in the order
`partner_ref`, `amount`, `currency`, `window`. A reader matches columns by name.

## 4. Replay

The operator names a date. The service rebuilds the file for that date and uploads it
again. A replay overwrites the file of that date on the remote host.

## 5. Limits and timeouts

The whole export must finish inside the nightly window. The SFTP connect timeout is
60 s, and the service retries a failed upload 5 times. A partner with more than
50 000 payouts is split into two files.

## 6. Validation

A row without `currency` is written with an empty currency column, and the row is
counted as exported.

## 7. Monitoring

The service writes one summary line per run: partner count, row count, and the number
of failed uploads.
