# Release migration

## A1: coding taste excerpt
Preserve every rule and wording when a reviewer needs to copy the source.

## A2: configuration
- timeoutSeconds=10
- maxChars=100000
- comment: default timeout for the summarizer

## A3: SQL migration
```sql
-- add status
ALTER TABLE orders ADD COLUMN status text;
CREATE INDEX orders_status_idx ON orders(status);
```
