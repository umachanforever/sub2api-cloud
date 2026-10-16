//go:build js && wasm

// Command compat-wasm exposes the original protocol converters to Edge Functions.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"syscall/js"

	"github.com/Wei-Shaw/sub2api/internal/pkg/apicompat"
)

type request struct {
	Operation string            `json:"operation"`
	ID        string            `json:"id"`
	Body      json.RawMessage   `json:"body"`
	Reasoning map[string]string `json:"reasoning"`
}

var states = map[string]*apicompat.ChatCompletionsToResponsesStreamState{}

type anthropicState struct {
	stream   *apicompat.AnthropicEventToResponsesState
	mapping  apicompat.ResponsesClientToolMapping
	restorer *apicompat.ResponsesClientToolStreamRestorer
	gemini   *geminiStreamState
}

var anthropicStates = map[string]*anthropicState{}
var serial uint64

func handle(input request) (any, error) {
	if input.Operation == "fast_policy" {
		var value struct {
			Settings     json.RawMessage `json:"settings"`
			SettingsJSON *string         `json:"settings_json"`
			UserID       string          `json:"user_id"`
			AccountType  string          `json:"account_type"`
			Model        string          `json:"model"`
			Tier         string          `json:"tier"`
		}
		if err := json.Unmarshal(input.Body, &value); err != nil {
			return nil, err
		}
		raw := value.Settings
		if value.SettingsJSON != nil {
			raw = []byte(*value.SettingsJSON)
		}
		var settings OpenAIFastPolicySettings
		if json.Unmarshal(raw, &settings) != nil {
			settings = OpenAIFastPolicySettings{}
		}
		if value.Tier != "missing" {
			normalized := normalizeOpenAIServiceTier(value.Tier)
			if normalized == nil {
				return map[string]string{"action": "pass", "message": ""}, nil
			}
			value.Tier = *normalized
		}
		userID, _ := strconv.ParseInt(value.UserID, 10, 64)
		action, message := evaluateOpenAIFastPolicyWithSettings(&settings, userID, &Account{Platform: "openai", Type: value.AccountType}, value.Model, value.Tier)
		return map[string]string{"action": action, "message": message}, nil
	}
	if input.Operation == "codex_metadata" {
		var value struct {
			Model       string                  `json:"model"`
			Candidates  []UpstreamModelMetadata `json:"candidates"`
			Descriptor  json.RawMessage         `json:"descriptor"`
			Missing     bool                    `json:"missing"`
			Conflict    bool                    `json:"conflict"`
			PublicAlias bool                    `json:"public_alias"`
		}
		if err := json.Unmarshal(input.Body, &value); err != nil {
			return nil, err
		}
		if len(value.Candidates) == 0 || len(value.Candidates) > 10000 {
			return nil, fmt.Errorf("invalid metadata candidates")
		}
		metadata := intersectUpstreamModelMetadata(value.Model, value.Candidates)
		if value.Missing {
			metadata = codexModelMetadataOverride{UpstreamModelMetadata: UpstreamModelMetadata{CodexToolCapabilities: metadata.CodexToolCapabilities}}
		}
		if value.Conflict {
			metadata = codexModelMetadataOverride{reasoningConflict: true, inputModalitiesConflict: true}
		}
		if value.PublicAlias {
			metadata.DisplayName = value.Model
			metadata.Description = "Custom model routed through sub2api-cloud."
		}
		var descriptor configuredCodexModelDescriptor
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(value.Descriptor, &descriptor); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(value.Descriptor, &fields); err != nil {
			return nil, err
		}
		if fields == nil {
			return nil, fmt.Errorf("invalid metadata descriptor")
		}
		before, err := json.Marshal(descriptor)
		if err != nil {
			return nil, err
		}
		applyUpstreamModelMetadataToCodexDescriptor(&descriptor, metadata)
		after, err := json.Marshal(descriptor)
		if err != nil {
			return nil, err
		}
		var previous, updated map[string]json.RawMessage
		if err := json.Unmarshal(before, &previous); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(after, &updated); err != nil {
			return nil, err
		}
		for _, field := range []string{"display_name", "description", "default_reasoning_level", "supported_reasoning_levels", "input_modalities", "context_window", "max_context_window"} {
			if !bytes.Equal(previous[field], updated[field]) {
				value := updated[field]
				if len(value) == 0 {
					value = json.RawMessage("null")
				}
				fields[field] = value
			}
		}
		applyCodexToolCapabilities(fields, metadata.CodexToolCapabilities, true)
		return fields, nil
	}
	if input.Operation == "messages_request" {
		var body apicompat.AnthropicRequest
		if err := json.Unmarshal(input.Body, &body); err != nil {
			return nil, err
		}
		return apicompat.AnthropicToResponses(&body)
	}
	if input.Operation == "gemini_rest" {
		return json.RawMessage(normalizeGeminiRequestForAIStudio(input.Body)), nil
	}
	if input.Operation == "open_gemini" {
		opened, err := handle(request{Operation: "open_anthropic", Body: input.Body})
		if err != nil {
			return nil, err
		}
		result := opened.(map[string]any)
		id := result["id"].(string)
		body, err := json.Marshal(result["body"])
		if err != nil {
			delete(anthropicStates, id)
			return nil, err
		}
		converted, err := convertClaudeMessagesToGeminiGenerateContent(body)
		if err != nil {
			delete(anthropicStates, id)
			return nil, err
		}
		anthropicStates[id].gemini = &geminiStreamState{}
		return map[string]any{"id": id, "body": json.RawMessage(ensureGeminiFunctionCallThoughtSignatures(converted))}, nil
	}
	if input.Operation == "gemini_response" {
		var body map[string]any
		if err := json.Unmarshal(input.Body, &body); err != nil {
			return nil, err
		}
		message, usage := convertGeminiToClaudeMessage(body, input.ID, input.Body, true)
		// Restore cached input usage before the original Anthropic converter runs.
		message["usage"] = usage
		return message, nil
	}
	if input.Operation == "gemini_request" {
		converted, err := convertClaudeMessagesToGeminiGenerateContent(input.Body)
		if err != nil {
			return nil, err
		}
		return json.RawMessage(ensureGeminiFunctionCallThoughtSignatures(converted)), nil
	}
	if input.Operation == "open_anthropic" {
		if len(states)+len(anthropicStates) >= 32 {
			return nil, fmt.Errorf("capacity")
		}
		var raw map[string]any
		if err := json.Unmarshal(input.Body, &raw); err != nil {
			return nil, err
		}
		mapping, _, err := apicompat.AdaptResponsesClientTools(raw)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, err
		}
		var body apicompat.ResponsesRequest
		if err := json.Unmarshal(encoded, &body); err != nil {
			return nil, err
		}
		body.Stream = true
		converted, err := apicompat.ResponsesToAnthropicRequest(&body)
		if err != nil {
			return nil, err
		}
		stream := apicompat.NewAnthropicEventToResponsesState()
		stream.Model = body.Model
		serial++
		id := strconv.FormatUint(serial, 10)
		anthropicStates[id] = &anthropicState{stream: stream, mapping: mapping, restorer: apicompat.NewResponsesClientToolStreamRestorer(mapping)}
		return map[string]any{"id": id, "body": converted}, nil
	}
	if input.Operation == "open_chat" {
		if len(states)+len(anthropicStates) >= 32 {
			return nil, fmt.Errorf("capacity")
		}
		var body apicompat.ResponsesRequest
		if err := json.Unmarshal(input.Body, &body); err != nil {
			return nil, err
		}
		body.Stream = true
		converted, err := apicompat.ResponsesToChatCompletionsRequestWithOptions(&body, &apicompat.ResponsesToChatOptions{
			ReasoningContentByID: func(id string) string { return input.Reasoning[id] },
		})
		if err != nil {
			return nil, err
		}
		tools, err := apicompat.EffectiveResponsesTools(&body)
		if err != nil {
			return nil, err
		}
		state := apicompat.NewChatCompletionsToResponsesStreamState(body.Model)
		state.CustomTools = apicompat.CustomToolNames(tools)
		state.FunctionTools = apicompat.FunctionToolNames(tools)
		state.ToolSearchDeclared = apicompat.HasToolSearchTool(tools)
		state.NamespaceTools = apicompat.NamespaceToolNames(tools)
		serial++
		id := strconv.FormatUint(serial, 10)
		states[id] = state
		return map[string]any{"id": id, "body": converted}, nil
	}
	if input.Operation == "close" {
		delete(states, input.ID)
		delete(anthropicStates, input.ID)
		return nil, nil
	}
	if input.Operation == "stats" {
		return len(states) + len(anthropicStates), nil
	}
	if state := anthropicStates[input.ID]; state != nil {
		if state.gemini != nil {
			switch input.Operation {
			case "chunk_gemini", "finish_gemini":
				return geminiEvents(state, input.Body, input.Operation == "finish_gemini")
			case "failure_gemini":
				input.Operation = "failure_anthropic"
			case "json_gemini":
				message, err := handle(request{Operation: "gemini_response", Body: input.Body, ID: state.stream.Model})
				if err != nil {
					return nil, err
				}
				encoded, err := json.Marshal(message)
				if err != nil {
					return nil, err
				}
				return handle(request{Operation: "json_anthropic", Body: encoded, ID: input.ID})
			}
		}
		switch input.Operation {
		case "failure_anthropic":
			stream := state.stream
			inputTokens := stream.InputTokens + stream.CacheReadInputTokens + stream.CacheCreationInputTokens
			return map[string]any{"id": stream.ResponseID, "object": "response", "model": stream.Model, "status": "failed", "output": []any{}, "usage": map[string]any{"input_tokens": inputTokens, "output_tokens": stream.OutputTokens, "total_tokens": inputTokens + stream.OutputTokens, "cache_creation_input_tokens": stream.CacheCreationInputTokens, "input_tokens_details": map[string]int{"cached_tokens": stream.CacheReadInputTokens}}, "error": map[string]string{"code": "upstream_error", "message": "Upstream generation failed"}}, nil
		case "chunk_anthropic":
			var event apicompat.AnthropicStreamEvent
			if err := json.Unmarshal(input.Body, &event); err != nil {
				return nil, err
			}
			if event.Type == "error" {
				return nil, fmt.Errorf("upstream error")
			}
			if event.Type == "message_stop" && state.stream.StopReason == "" {
				return nil, fmt.Errorf("incomplete stream")
			}
			if event.Type == "content_block_stop" && state.stream.CurrentItemType == "function_call" && state.stream.CurrentArgs != "" && !json.Valid([]byte(state.stream.CurrentArgs)) {
				return nil, fmt.Errorf("invalid tool arguments")
			}
			return restoreAnthropicEvents(apicompat.AnthropicEventToResponsesEvents(&event, state.stream), state), nil
		case "finish_anthropic":
			if !state.stream.CreatedSent || state.stream.StopReason == "" {
				return nil, fmt.Errorf("incomplete stream")
			}
			return restoreAnthropicEvents(apicompat.FinalizeAnthropicResponsesStream(state.stream), state), nil
		case "json_anthropic":
			var response apicompat.AnthropicResponse
			if err := json.Unmarshal(input.Body, &response); err != nil {
				return nil, err
			}
			encoded, err := json.Marshal(apicompat.AnthropicToResponsesResponse(&response))
			if err != nil {
				return nil, err
			}
			restored, _, err := apicompat.RestoreResponsesClientToolPayload(encoded, state.mapping)
			if err != nil {
				return nil, err
			}
			return json.RawMessage(restored), nil
		default:
			return nil, fmt.Errorf("unknown operation")
		}
	}
	state := states[input.ID]
	if state == nil {
		return nil, fmt.Errorf("unknown stream")
	}
	switch input.Operation {
	case "failure_chat":
		return map[string]any{"id": state.ResponseID, "object": "response", "model": state.Model, "status": "failed", "usage": state.Usage, "output": []any{}, "error": map[string]string{"code": "upstream_error", "message": "Upstream generation failed"}}, nil
	case "chunk_chat":
		var chunk apicompat.ChatCompletionsChunk
		if err := json.Unmarshal(input.Body, &chunk); err != nil {
			return nil, err
		}
		return apicompat.ChatCompletionsChunkToResponsesEvents(&chunk, state), nil
	case "finish_chat":
		if state.FinishReason == "" {
			return nil, fmt.Errorf("incomplete stream")
		}
		if err := state.ValidateToolCallArguments(); err != nil {
			return nil, err
		}
		return apicompat.FinalizeChatCompletionsResponsesStream(state), nil
	case "json_chat":
		var response apicompat.ChatCompletionsResponse
		if err := json.Unmarshal(input.Body, &response); err != nil {
			return nil, err
		}
		return apicompat.ChatCompletionsResponseToResponses(&response, state.Model, state.CustomTools, state.FunctionTools, state.ToolSearchDeclared, state.NamespaceTools), nil
	default:
		return nil, fmt.Errorf("unknown operation")
	}
}

func restoreAnthropicEvents(events []apicompat.ResponsesStreamEvent, state *anthropicState) []apicompat.ResponsesStreamEvent {
	var restored []apicompat.ResponsesStreamEvent
	for _, event := range events {
		restored = append(restored, state.restorer.Restore(event)...)
	}
	return restored
}

func invoke(_ js.Value, args []js.Value) (result any) {
	defer func() {
		if recover() != nil {
			result = `{"error":"conversion_failed"}`
		}
	}()
	var input request
	if len(args) != 1 || json.Unmarshal([]byte(args[0].String()), &input) != nil {
		return `{"error":"conversion_failed"}`
	}
	value, err := handle(input)
	if err != nil {
		if err.Error() == "capacity" {
			return `{"error":"capacity"}`
		}
		return `{"error":"conversion_failed"}`
	}
	encoded, err := json.Marshal(map[string]any{"value": value})
	if err != nil {
		return `{"error":"conversion_failed"}`
	}
	return string(encoded)
}

func main() {
	js.Global().Set("__s2aCompatCall", js.FuncOf(invoke))
	select {}
}
