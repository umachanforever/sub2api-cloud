package service

import "github.com/Wei-Shaw/sub2api/internal/config"

// Cloud-owned workers must never compete with the authoritative gateway runtime.
func startLocalGatewayWorker(cfg *config.Config, start func()) {
	if cfg == nil || !cfg.Supabase.Enabled() {
		start()
	}
}
