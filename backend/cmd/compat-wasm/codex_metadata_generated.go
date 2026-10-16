//go:build js && wasm

// Code generated from original Sub2API catalog metadata; DO NOT EDIT.
package main

import (
	bytes "bytes"
	json "encoding/json"
	strings "strings"
)

var codexToolCapabilityFields = []string{
	"service_tiers",
	"supports_search_tool", "apply_patch_tool_type", "comp_hash", "tool_mode", "use_responses_lite",
	"multi_agent_reasoning_effort", "multi_agent_version",
}

func applyCodexToolCapabilities(dst, src map[string]json.RawMessage, overwrite bool) bool {
	changed := false
	for _, field := range codexToolCapabilityFields {
		value := bytes.TrimSpace(src[field])
		if len(value) == 0 {
			continue
		}
		if field == "service_tiers" && bytes.Equal(value, []byte("null")) {
			value = []byte("[]")
		}

		if !bytes.Equal(value, []byte("null")) {
			if field == "service_tiers" {
				var tiers []configuredCodexServiceTier
				if json.Unmarshal(value, &tiers) != nil {
					continue
				}
			} else if field == "supports_search_tool" || field == "use_responses_lite" {
				if !bytes.Equal(value, []byte("true")) && !bytes.Equal(value, []byte("false")) {
					continue
				}
			} else {
				var text string
				if json.Unmarshal(value, &text) != nil {
					continue
				}
			}
		}
		current, exists := dst[field]
		if (exists && !overwrite) || bytes.Equal(current, value) {
			continue
		}
		dst[field] = append(json.RawMessage(nil), value...)
		changed = true
	}
	return changed
}

func intersectUpstreamModelMetadata(modelID string, candidates []UpstreamModelMetadata) codexModelMetadataOverride {
	result := codexModelMetadataOverride{UpstreamModelMetadata: UpstreamModelMetadata{ID: strings.TrimSpace(modelID)}}
	result.CodexToolCapabilities = make(map[string]json.RawMessage)
	for _, field := range codexToolCapabilityFields {
		value := bytes.TrimSpace(candidates[0].CodexToolCapabilities[field])
		shared := len(value) > 0
		declared := shared
		for _, candidate := range candidates[1:] {
			declared = declared || len(candidate.CodexToolCapabilities[field]) > 0
			if !bytes.Equal(value, bytes.TrimSpace(candidate.CodexToolCapabilities[field])) {
				shared = false
			}
		}
		if shared {
			result.CodexToolCapabilities[field] = value
		} else if declared {
			fallback := json.RawMessage("null")
			switch field {
			case "supports_search_tool", "use_responses_lite":
				fallback = json.RawMessage("false")
			case "service_tiers":
				fallback = json.RawMessage("[]")
			}
			result.CodexToolCapabilities[field] = fallback
		}
	}
	for _, candidate := range candidates {
		if result.DisplayName == "" && strings.TrimSpace(candidate.DisplayName) != "" {
			result.DisplayName = strings.TrimSpace(candidate.DisplayName)
		}
		if result.Description == "" && strings.TrimSpace(candidate.Description) != "" {
			result.Description = strings.TrimSpace(candidate.Description)
		}
	}

	reasoningKnown := true
	reasoningValue := false
	for i, candidate := range candidates {
		if candidate.Reasoning == nil {
			reasoningKnown = false
			break
		}
		if i == 0 {
			reasoningValue = *candidate.Reasoning
			continue
		}
		if reasoningValue != *candidate.Reasoning {
			reasoningKnown = false
			result.reasoningConflict = true
			break
		}
	}
	if reasoningKnown {
		result.Reasoning = &reasoningValue
		if reasoningValue {
			levels := normalizeReasoningLevels(candidates[0].SupportedReasoningLevels)
			for _, candidate := range candidates[1:] {
				levels = intersectOrderedStrings(levels, normalizeReasoningLevels(candidate.SupportedReasoningLevels))
			}
			result.SupportedReasoningLevels = levels
			if len(levels) == 0 {
				result.reasoningConflict = true
			} else {
				sharedDefault := normalizeReasoningLevel(candidates[0].DefaultReasoningLevel)
				for _, candidate := range candidates[1:] {
					if normalizeReasoningLevel(candidate.DefaultReasoningLevel) != sharedDefault {
						sharedDefault = ""
						break
					}
				}
				if !stringSliceContains(levels, sharedDefault) {
					sharedDefault = levels[0]
				}
				result.DefaultReasoningLevel = sharedDefault
			}
		}
	}

	modalitiesKnown := true
	modalities := normalizeCodexInputModalities(candidates[0].InputModalities)
	if len(modalities) == 0 {
		modalitiesKnown = false
	}
	for _, candidate := range candidates[1:] {
		candidateModalities := normalizeCodexInputModalities(candidate.InputModalities)
		if len(candidateModalities) == 0 {
			modalitiesKnown = false
			break
		}
		modalities = intersectOrderedStrings(modalities, candidateModalities)
	}
	if modalitiesKnown && len(modalities) > 0 {
		result.InputModalities = modalities
	} else if modalitiesKnown {
		result.inputModalitiesConflict = true
	}

	contextKnown := true
	for i, candidate := range candidates {
		if candidate.ContextWindow <= 0 {
			contextKnown = false
			break
		}
		if i == 0 || candidate.ContextWindow < result.ContextWindow {
			result.ContextWindow = candidate.ContextWindow
		}
	}
	if !contextKnown {
		result.ContextWindow = 0
	}
	for i, candidate := range candidates {
		maxContextWindow := candidate.MaxContextWindow
		if maxContextWindow <= 0 {

			maxContextWindow = candidate.ContextWindow
		}
		if maxContextWindow <= 0 {
			result.MaxContextWindow = 0
			break
		}
		if i == 0 || maxContextWindow < result.MaxContextWindow {
			result.MaxContextWindow = maxContextWindow
		}
	}
	return result
}

func applyUpstreamModelMetadataToCodexDescriptor(
	descriptor *configuredCodexModelDescriptor,
	metadata codexModelMetadataOverride,
) {
	if descriptor == nil {
		return
	}
	if strings.TrimSpace(metadata.DisplayName) != "" {
		descriptor.DisplayName = strings.TrimSpace(metadata.DisplayName)
	}
	if strings.TrimSpace(metadata.Description) != "" {
		descriptor.Description = strings.TrimSpace(metadata.Description)
	}
	if metadata.reasoningConflict {
		descriptor.DefaultReasoningLevel = nil
		descriptor.SupportedReasoningLevels = []configuredCodexReasoningLevel{}
	} else if metadata.Reasoning != nil && !*metadata.Reasoning {
		none := "none"
		descriptor.DefaultReasoningLevel = &none
		descriptor.SupportedReasoningLevels = []configuredCodexReasoningLevel{{
			Effort:      "none",
			Description: configuredCodexReasoningLevelDescription("none"),
		}}
	} else if metadata.Reasoning != nil && *metadata.Reasoning {
		levels := normalizeReasoningLevels(metadata.SupportedReasoningLevels)
		if len(levels) == 0 {
			descriptor.DefaultReasoningLevel = nil
			descriptor.SupportedReasoningLevels = []configuredCodexReasoningLevel{}
		} else {
			defaultLevel := normalizeReasoningLevel(metadata.DefaultReasoningLevel)
			if !stringSliceContains(levels, defaultLevel) {
				defaultLevel = levels[0]
			}
			descriptor.DefaultReasoningLevel = &defaultLevel
			descriptor.SupportedReasoningLevels = make([]configuredCodexReasoningLevel, 0, len(levels))
			for _, level := range levels {
				descriptor.SupportedReasoningLevels = append(descriptor.SupportedReasoningLevels, configuredCodexReasoningLevel{
					Effort:      level,
					Description: configuredCodexReasoningLevelDescription(level),
				})
			}
		}
	}
	if metadata.inputModalitiesConflict {
		descriptor.InputModalities = []string{"text"}
	} else if modalities := normalizeCodexInputModalities(metadata.InputModalities); len(modalities) > 0 {
		descriptor.InputModalities = modalities
	}
	if metadata.ContextWindow > 0 {
		descriptor.ContextWindow = metadata.ContextWindow
		descriptor.MaxContextWindow = metadata.ContextWindow
	}
	if metadata.MaxContextWindow > 0 {
		descriptor.MaxContextWindow = metadata.MaxContextWindow
		descriptor.ContextWindow = min(descriptor.ContextWindow, metadata.MaxContextWindow)
	}
}

func configuredCodexReasoningLevelDescription(level string) string {
	switch level {
	case "none":
		return "Use the model's default behavior without configurable reasoning"
	case "minimal":
		return "Minimal reasoning for the fastest responses"
	case "low":
		return "Fast responses with lighter reasoning"
	case "medium":
		return "Balanced reasoning for most coding tasks"
	case "high":
		return "Greater reasoning depth for coding and agent tasks"
	case "xhigh":
		return "Extra-high reasoning depth for difficult tasks"
	case "max":
		return "Maximum reasoning depth for complex tasks"
	case "ultra":
		return "Maximum reasoning with automatic task delegation"
	default:
		return "Reasoning effort supported by the upstream model"
	}
}

func intersectOrderedStrings(left, right []string) []string {
	rightSet := make(map[string]struct{}, len(right))
	for _, value := range right {
		rightSet[value] = struct{}{}
	}
	intersection := make([]string, 0, len(left))
	for _, value := range left {
		if _, ok := rightSet[value]; ok {
			intersection = append(intersection, value)
		}
	}
	return intersection
}

func stringSliceContains(values []string, target string) bool {
	if target == "" {
		return false
	}
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

type configuredCodexReasoningLevel struct {
	Effort      string `json:"effort"`
	Description string `json:"description"`
}

type configuredCodexTruncationPolicy struct {
	Mode  string `json:"mode"`
	Limit int64  `json:"limit"`
}

type configuredCodexServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type configuredCodexModelMessages struct {
	InstructionsTemplate  string `json:"instructions_template"`
	InstructionsVariables any    `json:"instructions_variables"`
	Approvals             any    `json:"approvals"`
	CollaborationModes    any    `json:"collaboration_modes"`
	AutoReview            any    `json:"auto_review"`
	Permissions           any    `json:"permissions"`
	MultiAgent            any    `json:"multi_agent"`
	TokenBudget           any    `json:"token_budget"`
	GuardianV2            any    `json:"guardian_v2"`
}

type configuredCodexModelDescriptor struct {
	officialMetadata                  json.RawMessage
	Slug                              string                          `json:"slug"`
	DisplayName                       string                          `json:"display_name"`
	Description                       string                          `json:"description"`
	DefaultReasoningLevel             *string                         `json:"default_reasoning_level,omitempty"`
	SupportedReasoningLevels          []configuredCodexReasoningLevel `json:"supported_reasoning_levels"`
	MultiAgentReasoningEffort         *string                         `json:"multi_agent_reasoning_effort,omitempty"`
	ShellType                         string                          `json:"shell_type"`
	Visibility                        string                          `json:"visibility"`
	SupportedInAPI                    bool                            `json:"supported_in_api"`
	Priority                          int                             `json:"priority"`
	AdditionalSpeedTiers              []string                        `json:"additional_speed_tiers"`
	ServiceTiers                      []configuredCodexServiceTier    `json:"service_tiers"`
	DefaultServiceTier                any                             `json:"default_service_tier"`
	AvailabilityNUX                   any                             `json:"availability_nux"`
	Upgrade                           any                             `json:"upgrade"`
	ModelMessages                     configuredCodexModelMessages    `json:"model_messages"`
	IncludeSkillsUsageInstructions    bool                            `json:"include_skills_usage_instructions"`
	IncludePluginUsageInstructions    bool                            `json:"include_plugin_usage_instructions"`
	IncludeAppsUsageInstructions      bool                            `json:"include_apps_usage_instructions"`
	SupportsReasoningSummaryParameter bool                            `json:"supports_reasoning_summary_parameter"`
	DefaultReasoningSummary           string                          `json:"default_reasoning_summary"`
	SupportVerbosity                  bool                            `json:"support_verbosity"`
	DefaultVerbosity                  *string                         `json:"default_verbosity"`
	ApplyPatchToolType                *string                         `json:"apply_patch_tool_type"`
	WebSearchToolType                 string                          `json:"web_search_tool_type"`
	TruncationPolicy                  configuredCodexTruncationPolicy `json:"truncation_policy"`
	SupportsImageDetailOriginal       bool                            `json:"supports_image_detail_original"`
	SupportsParallelToolCalls         bool                            `json:"supports_parallel_tool_calls"`
	ContextWindow                     int64                           `json:"context_window"`
	MaxContextWindow                  int64                           `json:"max_context_window"`
	AutoCompactTokenLimit             any                             `json:"auto_compact_token_limit"`
	CompHash                          any                             `json:"comp_hash"`
	EffectiveContextWindowPercent     int64                           `json:"effective_context_window_percent"`
	ExperimentalSupportedTools        []string                        `json:"experimental_supported_tools"`
	InputModalities                   []string                        `json:"input_modalities"`
	SupportsSearchTool                bool                            `json:"supports_search_tool"`
	UseResponsesLite                  bool                            `json:"use_responses_lite"`
	NodeREPLAutoReviewRequired        bool                            `json:"node_repl_auto_review_required"`
	NodeREPLDisabled                  bool                            `json:"node_repl_disabled"`
	AutoReviewModelOverride           any                             `json:"auto_review_model_override"`
	ModelSpecialty                    any                             `json:"model_specialty"`
	ToolMode                          any                             `json:"tool_mode"`
	MultiAgentVersion                 any                             `json:"multi_agent_version"`
}

type codexModelMetadataOverride struct {
	UpstreamModelMetadata
	reasoningConflict       bool
	inputModalitiesConflict bool
}

type UpstreamModelMetadata struct {
	ID                       string                     `json:"id"`
	DisplayName              string                     `json:"display_name,omitempty"`
	Description              string                     `json:"description,omitempty"`
	Reasoning                *bool                      `json:"reasoning,omitempty"`
	DefaultReasoningLevel    string                     `json:"default_reasoning_level,omitempty"`
	SupportedReasoningLevels []string                   `json:"supported_reasoning_levels,omitempty"`
	InputModalities          []string                   `json:"input_modalities,omitempty"`
	ContextWindow            int64                      `json:"context_window,omitempty"`
	MaxContextWindow         int64                      `json:"max_context_window,omitempty"`
	MaxOutputTokens          int64                      `json:"max_output_tokens,omitempty"`
	CodexToolCapabilities    map[string]json.RawMessage `json:"codex_tool_capabilities,omitempty"`
}

func normalizeReasoningLevels(levels []string) []string {
	seen := make(map[string]struct{}, len(levels))
	normalized := make([]string, 0, len(levels))
	for _, level := range levels {
		level = normalizeReasoningLevel(level)
		if level == "" {
			continue
		}
		if _, exists := seen[level]; exists {
			continue
		}
		seen[level] = struct{}{}
		normalized = append(normalized, level)
	}
	return normalized
}

func normalizeReasoningLevel(level string) string {
	level = strings.ToLower(strings.TrimSpace(level))
	switch level {
	case "off", "disabled":
		return "none"
	case "extra-high", "extra_high":
		return "xhigh"
	case "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra":
		return level
	default:
		return ""
	}
}

func normalizeCodexInputModalities(modalities []string) []string {
	seen := make(map[string]struct{}, len(modalities))
	normalized := make([]string, 0, len(modalities))
	for _, modality := range modalities {
		modality = strings.ToLower(strings.TrimSpace(modality))
		if modality != "text" && modality != "image" {
			continue
		}
		if _, exists := seen[modality]; exists {
			continue
		}
		seen[modality] = struct{}{}
		normalized = append(normalized, modality)
	}
	return normalized
}
