-- +goose Up
-- Role hierarchy user < admin < super_admin. Only a super_admin may grant or
-- revoke admin/super_admin and sees every household device and pairing
-- request (Admin → «Устройства»). Existing admins stay admins; promote the
-- owner with `martytv admin set-role --username NAME --role super_admin`.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'super_admin'));

-- +goose Down
UPDATE users SET role = 'admin' WHERE role = 'super_admin';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user'));
