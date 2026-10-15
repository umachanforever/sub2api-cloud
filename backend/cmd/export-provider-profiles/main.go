// Command export-provider-profiles exports original multi-protocol provider defaults.
package main

import (
	"encoding/json"
	"os"

	"github.com/Wei-Shaw/sub2api/internal/domain"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

func main() {
	profiles := map[string]*service.ProviderProfile{}
	for _, platform := range domain.Platforms() {
		if profile := service.LookupProviderProfile(platform.ID); profile != nil {
			profiles[platform.ID] = profile
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(profiles); err != nil {
		panic(err)
	}
}
