INSERT INTO "permissions" ("code", "resource", "action")
VALUES ('fb_account:bind', 'fb_account', 'bind')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" IN ('Operator', 'Viewer')
  AND p."code" = 'fb_account:bind'
ON CONFLICT DO NOTHING;
