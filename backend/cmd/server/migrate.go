package main

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/repository"
)

func validateMigrationURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.User == nil || u.User.Username() == "" || u.Fragment != "" || strings.Trim(u.Path, "/") == "" {
		return fmt.Errorf("DATABASE_URL must specify a PostgreSQL host, user, and database")
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q["sslmode"]) > 1 || q.Has("host") || q.Has("hostaddr") || q.Has("user") || q.Has("dbname") || q.Has("service") {
		return fmt.Errorf("DATABASE_URL contains invalid or overridden connection parameters")
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	local := host == "localhost" || host == "host.docker.internal" || ip != nil && ip.IsLoopback()
	if !local && q.Get("sslmode") != "require" && q.Get("sslmode") != "verify-full" && q.Get("sslmode") != "verify-ca" {
		return fmt.Errorf("remote management migrations require TLS")
	}
	return nil
}

func runManagementMigrations(ctx context.Context, databaseURL string) error {
	if os.Getenv("SUPABASE_URL") == "" {
		return fmt.Errorf("SUPABASE_URL is required for isolated management migrations")
	}
	if err := validateMigrationURL(databaseURL); err != nil {
		return err
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return fmt.Errorf("cannot open management database connection")
	}
	defer db.Close()
	return repository.ApplyMigrations(ctx, db)
}
