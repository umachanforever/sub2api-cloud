// Command export-codex-catalog exports the original model descriptors for the cloud runtime.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(input io.Reader, output io.Writer) error {
	var models []string
	decoder := json.NewDecoder(io.LimitReader(input, 1<<20))
	if err := decoder.Decode(&models); err != nil {
		return fmt.Errorf("decode model IDs: %w", err)
	}
	if len(models) > 1000 {
		return fmt.Errorf("too many model IDs")
	}
	for _, model := range models {
		if len(model) > 200 {
			return fmt.Errorf("model ID exceeds 200 bytes")
		}
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("expected one model ID array")
	}
	body, err := service.BuildCodexModelsManifest(models)
	if err != nil {
		return fmt.Errorf("build model descriptors: %w", err)
	}
	_, err = output.Write(append(body, '\n'))
	return err
}
