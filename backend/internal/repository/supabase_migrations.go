package repository

import (
	"context"
	"database/sql"
	"fmt"
	"os"
)

type supabaseMigrationContextKey struct{}

// Check before any DDL, including the initial setup path that precedes config loading.
func validateSupabaseMigrationRole(ctx context.Context, conn *sql.Conn) error {
	enabled, _ := ctx.Value(supabaseMigrationContextKey{}).(bool)
	if !enabled && os.Getenv("SUPABASE_URL") == "" {
		return nil
	}
	var safe bool
	err := conn.QueryRowContext(ctx, `SELECT
        current_user = 's2a_management'
        AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
        AND NOT EXISTS (
            SELECT FROM pg_auth_members m WHERE m.member = r.oid OR (
                m.roleid = r.oid AND m.member NOT IN (
                    SELECT oid FROM pg_roles WHERE rolsuper OR rolname IN ('postgres', 'supabase_admin')
                )
            )
        )
        AND EXISTS (SELECT FROM pg_default_acl WHERE defaclrole = r.oid AND defaclobjtype = 'f' AND defaclnamespace = 0)
        AND NOT EXISTS (
            SELECT FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
            WHERE d.defaclrole = r.oid
            AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
            AND a.grantee <> r.oid
        )
        FROM pg_roles r WHERE rolname = current_user`).Scan(&safe)
	if err != nil {
		return fmt.Errorf("verify Supabase management migration role: %w", err)
	}
	if !safe {
		return fmt.Errorf("Supabase management migrations require isolated s2a_management ownership; apply deploy/management-role.sql and use its database login")
	}
	return nil
}

// Read migration metadata once across the remote connection while holding its advisory lock.
func supabaseMigrationChecksums(ctx context.Context, conn *sql.Conn) (map[string]string, error) {
	enabled, _ := ctx.Value(supabaseMigrationContextKey{}).(bool)
	if !enabled && os.Getenv("SUPABASE_URL") == "" {
		return nil, nil
	}
	rows, err := conn.QueryContext(ctx, "SELECT filename, checksum FROM schema_migrations")
	if err != nil {
		return nil, fmt.Errorf("read Supabase migration checksums: %w", err)
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var name, checksum string
		if err := rows.Scan(&name, &checksum); err != nil {
			return nil, fmt.Errorf("scan Supabase migration checksum: %w", err)
		}
		result[name] = checksum
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Supabase migration checksums: %w", err)
	}
	return result, nil
}
