//go:build js && wasm

// Command compat-wasm exposes the original protocol converters to Edge Functions.
package main

import (
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
var serial uint64

func handle(input request) (any, error) {
	if input.Operation == "open_chat" {
		if len(states) >= 32 {
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
		return nil, nil
	}
	if input.Operation == "stats" {
		return len(states), nil
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
