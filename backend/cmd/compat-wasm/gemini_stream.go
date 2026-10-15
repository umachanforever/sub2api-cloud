//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/apicompat"
)

// Gemini stream transport feeds the original Anthropic event and tool restorers.
type geminiStreamState struct {
	started  bool
	index    int
	open     string
	text     string
	toolName string
	toolJSON string
	finish   string
	sawTool  bool
}

func geminiEvents(state *anthropicState, raw json.RawMessage, finish bool) ([]apicompat.ResponsesStreamEvent, error) {
	g := state.gemini
	var events []apicompat.ResponsesStreamEvent
	emit := func(event apicompat.AnthropicStreamEvent) {
		events = append(events, restoreAnthropicEvents(apicompat.AnthropicEventToResponsesEvents(&event, state.stream), state)...)
	}
	closeBlock := func() error {
		if g.open == "" {
			return nil
		}
		if g.open == "tool" && !json.Valid([]byte(g.toolJSON)) {
			return fmt.Errorf("invalid tool arguments")
		}
		emit(apicompat.AnthropicStreamEvent{Type: "content_block_stop"})
		g.open = ""
		g.toolName = ""
		g.toolJSON = ""
		return nil
	}
	if finish {
		if !g.started || g.finish == "" {
			return nil, fmt.Errorf("incomplete stream")
		}
		if err := closeBlock(); err != nil {
			return nil, err
		}
		reason := mapGeminiFinishReasonToClaudeStopReason(g.finish)
		if g.sawTool {
			reason = "tool_use"
		}
		emit(apicompat.AnthropicStreamEvent{Type: "message_delta", Delta: &apicompat.AnthropicDelta{Type: "message_delta", StopReason: reason}, Usage: &apicompat.AnthropicUsage{InputTokens: state.stream.InputTokens, CacheReadInputTokens: state.stream.CacheReadInputTokens, OutputTokens: state.stream.OutputTokens}})
		emit(apicompat.AnthropicStreamEvent{Type: "message_stop"})
		return events, nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	if body["error"] != nil {
		return nil, fmt.Errorf("upstream error")
	}
	if !g.started {
		g.started = true
		emit(apicompat.AnthropicStreamEvent{Type: "message_start", Message: &apicompat.AnthropicResponse{ID: generateAnthropicMsgID(), Model: state.stream.Model, Content: []apicompat.AnthropicContentBlock{}}})
	}
	if usage := extractGeminiUsage(raw); usage != nil {
		state.stream.InputTokens = usage.InputTokens
		state.stream.OutputTokens = usage.OutputTokens
		state.stream.CacheReadInputTokens = usage.CacheReadInputTokens
	}
	if reason := extractGeminiFinishReason(body); reason != "" {
		g.finish = reason
	}
	for _, part := range extractGeminiParts(body) {
		text, _ := part["text"].(string)
		if image, ok := part["inlineData"].(map[string]any); ok {
			mime, _ := image["mimeType"].(string)
			data, _ := image["data"].(string)
			if isGeminiInlineImageMIMEType(mime) && isValidBase64(data) {
				text += fmt.Sprintf("![image](data:%s;base64,%s)", mime, data)
			}
		}
		if text != "" {
			delta, seen := computeGeminiTextDelta(g.text, text)
			g.text = seen
			if delta != "" {
				if g.open != "text" {
					if err := closeBlock(); err != nil {
						return nil, err
					}
					index := g.index
					g.index++
					g.open = "text"
					emit(apicompat.AnthropicStreamEvent{Type: "content_block_start", Index: &index, ContentBlock: &apicompat.AnthropicContentBlock{Type: "text"}})
				}
				emit(apicompat.AnthropicStreamEvent{Type: "content_block_delta", Delta: &apicompat.AnthropicDelta{Type: "text_delta", Text: delta}})
			}
		}
		if tool, ok := part["functionCall"].(map[string]any); ok {
			name, _ := tool["name"].(string)
			if strings.TrimSpace(name) == "" {
				name = "tool"
			}
			if g.open != "tool" || g.toolName != name {
				if err := closeBlock(); err != nil {
					return nil, err
				}
				index := g.index
				g.index++
				g.open = "tool"
				g.toolName = name
				g.sawTool = true
				emit(apicompat.AnthropicStreamEvent{Type: "content_block_start", Index: &index, ContentBlock: &apicompat.AnthropicContentBlock{Type: "tool_use", ID: "toolu_" + randomHex(8), Name: name, Input: json.RawMessage(`{}`)}})
			}
			args := "{}"
			switch value := tool["args"].(type) {
			case nil:
			case string:
				if strings.TrimSpace(value) != "" {
					args = value
				}
			default:
				encoded, err := json.Marshal(value)
				if err != nil {
					return nil, err
				}
				args = string(encoded)
			}
			delta, seen := computeGeminiTextDelta(g.toolJSON, args)
			g.toolJSON = seen
			if delta != "" {
				emit(apicompat.AnthropicStreamEvent{Type: "content_block_delta", Delta: &apicompat.AnthropicDelta{Type: "input_json_delta", PartialJSON: delta}})
			}
		}
	}
	return events, nil
}
