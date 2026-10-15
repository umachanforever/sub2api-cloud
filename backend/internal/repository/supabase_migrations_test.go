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
