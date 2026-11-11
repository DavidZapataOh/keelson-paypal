-- Apps that registered themselves (RFC 7591) before the delegated scopes existed may ask for them too.
UPDATE "oauth_client"
SET "scopes" = ARRAY['alibis:read', 'mandates:request', 'evidence:write', 'purchases:write', 'offline_access']
WHERE "token_endpoint_auth_method" = 'none' AND "scopes" = ARRAY['alibis:read'];
