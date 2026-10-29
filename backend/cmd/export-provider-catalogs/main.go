// Command export-provider-catalogs exports the vendored provider model metadata.
package main

import (
	"encoding/json"
	"github.com/Wei-Shaw/sub2api/internal/pkg/antigravity"
	"github.com/Wei-Shaw/sub2api/internal/pkg/claude"
	"github.com/Wei-Shaw/sub2api/internal/pkg/geminicli"
	"github.com/Wei-Shaw/sub2api/internal/pkg/openai"
	"os"
)

func main() {
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"providers":   map[string]any{"openai": openai.DefaultModels, "anthropic": claude.DefaultModels, "gemini": geminicli.DefaultModels},
		"antigravity": antigravity.DefaultModels(),
	}); err != nil {
		panic(err)
	}
}
