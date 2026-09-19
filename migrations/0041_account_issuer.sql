-- better-auth 1.7.0–1.7.2 writes account.issuer on every Google link. The 1.6 table never
-- had the column, so the callback failed with internal_server_error.
ALTER TABLE account ADD COLUMN issuer TEXT;
UPDATE account SET issuer = 'https://accounts.google.com' WHERE providerId = 'google' AND issuer IS NULL;
