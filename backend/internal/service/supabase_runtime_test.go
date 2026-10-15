package service

import (
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestLocalGatewayWorkerOwnership(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  *config.Config
		want bool
	}{
		{"native default", nil, true},
		{"native configured", &config.Config{}, true},
		{"cloud identity", &config.Config{Supabase: config.SupabaseConfig{URL: "https://project.supabase.co"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			started := false
			startLocalGatewayWorker(tc.cfg, func() { started = true })
			require.Equal(t, tc.want, started)
		})
	}
}
