package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestExportPreservesOriginalCodexMetadata(t *testing.T) {
	var output bytes.Buffer
	if err := run(strings.NewReader(`["gpt-6.1-sol","gpt-image-1","custom-model","gpt-6.1-sol"]`), &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Models []struct {
			Slug                     string `json:"slug"`
			SupportedReasoningLevels []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
			ModelMessages struct {
				Instructions string `json:"instructions_template"`
			} `json:"model_messages"`
		}
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Models) != 2 {
		t.Fatalf("expected deduplicated text descriptors without image-only model, got %d", len(result.Models))
	}
	sol := result.Models[0]
	if sol.Slug != "gpt-6.1-sol" || len(sol.ModelMessages.Instructions) == 0 {
		t.Fatal("original model identity or instructions lost")
	}
	max := false
	for _, level := range sol.SupportedReasoningLevels {
		if level.Effort == "max" {
			max = true
		}
		if level.Effort == "none" {
			t.Fatal("unsupported reasoning level introduced")
		}
	}
	if !max {
		t.Fatal("original max reasoning metadata lost")
	}
}

func TestExportRejectsInvalidInput(t *testing.T) {
	for _, input := range []string{`{}`, `[`, `["model"] []`, `["` + strings.Repeat("x", 201) + `"]`, `[` + strings.Repeat(`"x",`, 1000) + `"x"]`} {
		if err := run(strings.NewReader(input), new(bytes.Buffer)); err == nil {
			t.Fatal("invalid model input accepted")
		}
	}
}
