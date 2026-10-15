// Command export-antigravity-mapping exports effective catalog mapping rules.
package main

import (
	"encoding/json"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"os"
)

func main() {
	defaults := (&service.Account{Platform: "antigravity"}).GetModelMapping()
	custom := (&service.Account{Platform: "antigravity", Credentials: map[string]any{"model_mapping": map[string]any{"__fixture__": "__fixture__"}}}).GetModelMapping()
	delete(custom, "__fixture__")
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"defaults": defaults, "supplemental": custom}); err != nil {
		panic(err)
	}
}
