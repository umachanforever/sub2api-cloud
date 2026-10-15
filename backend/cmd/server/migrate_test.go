package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestManagementMigrationURL(t *testing.T) {
	for _, tc := range []struct {
		url   string
		valid bool
	}{
		{"postgres://s2a_management:secret@127.0.0.1:5432/postgres?sslmode=disable", true},
		{"postgresql://s2a_management:secret@db.example.com/postgres?sslmode=verify-full", true},
		{"postgres://s2a_management:secret@db.example.com/postgres?sslmode=require", true},
		{"postgres://s2a_management:secret@db.example.com/postgres", false},
		{"postgres://s2a_management:secret@db.example.com/postgres?sslmode=disable", false},
		{"postgres://s2a_management:secret@localhost/postgres?host=db.example.com", false},
		{"postgres://s2a_management:secret@localhost/postgres?sslmode=disable&sslmode=require", false},
		{"postgres://s2a_management:secret@localhost/postgres?dbname=other", false},
		{"postgres://s2a_management:secret@localhost", false},
		{"postgres://localhost/postgres", false},
		{"https://s2a_management:secret@localhost/postgres", false},
		{"postgres://s2a_management:%zz@localhost/postgres", false},
	} {
		err := validateMigrationURL(tc.url)
		if tc.valid {
			require.NoError(t, err)
		} else {
			require.Error(t, err)
			require.NotContains(t, err.Error(), "secret")
		}
	}
}
