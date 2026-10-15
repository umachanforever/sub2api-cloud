package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"
)

func TestSupabaseMigrationRole(t *testing.T) {
	for _, tc := range []struct {
		name       string
		url        string
		configured bool
		safe       bool
		queryErr   error
		wantErr    bool
	}{
		{name: "native"},
		{name: "isolated", url: "http://localhost:54321", safe: true},
		{name: "config file", configured: true, safe: true},
		{name: "privileged or exposed", url: "http://localhost:54321", wantErr: true},
		{name: "database unavailable", url: "http://localhost:54321", queryErr: errors.New("offline"), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SUPABASE_URL", tc.url)
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			defer db.Close()
			conn, err := db.Conn(context.Background())
			require.NoError(t, err)
			defer conn.Close()
			if tc.url != "" || tc.configured {
				q := mock.ExpectQuery("SELECT.*current_user")
				if tc.queryErr != nil {
					q.WillReturnError(tc.queryErr)
				} else {
					q.WillReturnRows(sqlmock.NewRows([]string{"safe"}).AddRow(tc.safe))
				}
			}
			ctx := context.WithValue(context.Background(), supabaseMigrationContextKey{}, tc.configured)
			err = validateSupabaseMigrationRole(ctx, conn)
			if tc.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.NoError(t, mock.ExpectationsWereMet())
		})
	}
}

func TestSupabaseMigrationChecksums(t *testing.T) {
	for _, mode := range []string{"native", "cloud", "configured", "offline", "interrupted"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("SUPABASE_URL", "")
			ctx := context.Background()
			if mode == "configured" {
				ctx = context.WithValue(ctx, supabaseMigrationContextKey{}, true)
			} else if mode != "native" {
				t.Setenv("SUPABASE_URL", "https://project.supabase.co")
			}
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			defer db.Close()
			conn, err := db.Conn(ctx)
			require.NoError(t, err)
			defer conn.Close()
			if mode != "native" {
				query := mock.ExpectQuery("SELECT filename, checksum FROM schema_migrations")
				if mode == "offline" {
					query.WillReturnError(errors.New("offline"))
				} else {
					rows := sqlmock.NewRows([]string{"filename", "checksum"}).AddRow("001.sql", "first").AddRow("002.sql", "second")
					if mode == "interrupted" {
						rows.RowError(1, errors.New("interrupted"))
					}
					query.WillReturnRows(rows).RowsWillBeClosed()
				}
			}
			checksums, err := supabaseMigrationChecksums(ctx, conn)
			if mode == "offline" || mode == "interrupted" {
				require.Error(t, err)
				require.Nil(t, checksums)
			} else {
				require.NoError(t, err)
				if mode == "native" {
					require.Nil(t, checksums)
				} else {
					require.Equal(t, map[string]string{"001.sql": "first", "002.sql": "second"}, checksums)
				}
			}
			require.NoError(t, mock.ExpectationsWereMet())
		})
	}
}
