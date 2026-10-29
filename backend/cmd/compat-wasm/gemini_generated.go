//go:build js && wasm

// Code generated from original Sub2API Gemini converters; DO NOT EDIT.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tidwall/gjson"
	"math"
	"strings"
)

const geminiDummyThoughtSignature = "skip_thought_signature_validator"

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func generateAnthropicMsgID() string {
	const charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	const idLen = 22
	randomBytes := make([]byte, idLen)
	if _, err := rand.Read(randomBytes); err != nil {
		return "msg_01" + randomHex(11)
	}
	b := make([]byte, idLen)
	for i := range b {
		b[i] = charset[int(randomBytes[i])%len(charset)]
	}
	return "msg_01" + string(b)
}

func convertGeminiToClaudeMessage(geminiResp map[string]any, originalModel string, rawData []byte, includeInlineData bool) (map[string]any, *ClaudeUsage) {
	usage := extractGeminiUsage(rawData)
	if usage == nil {
		usage = &ClaudeUsage{}
	}

	contentBlocks := make([]any, 0)
	sawToolUse := false
	if candidates, ok := geminiResp["candidates"].([]any); ok && len(candidates) > 0 {
		if cand, ok := candidates[0].(map[string]any); ok {
			if content, ok := cand["content"].(map[string]any); ok {
				if parts, ok := content["parts"].([]any); ok {
					for _, part := range parts {
						pm, ok := part.(map[string]any)
						if !ok {
							continue
						}
						if text, ok := pm["text"].(string); ok && text != "" {
							contentBlocks = append(contentBlocks, map[string]any{
								"type": "text",
								"text": text,
							})
						}
						if inlineData, ok := pm["inlineData"].(map[string]any); includeInlineData && ok {
							mimeType, _ := inlineData["mimeType"].(string)
							data, _ := inlineData["data"].(string)
							if isGeminiInlineImageMIMEType(mimeType) && isValidBase64(data) {
								contentBlocks = append(contentBlocks, map[string]any{
									"type": "text",
									"text": fmt.Sprintf("![image](data:%s;base64,%s)", mimeType, data),
								})
							}
						}
						if fc, ok := pm["functionCall"].(map[string]any); ok {
							name, _ := fc["name"].(string)
							if strings.TrimSpace(name) == "" {
								name = "tool"
							}
							args := fc["args"]
							sawToolUse = true
							contentBlocks = append(contentBlocks, map[string]any{
								"type":  "tool_use",
								"id":    "toolu_" + randomHex(8),
								"name":  name,
								"input": args,
							})
						}
					}
				}
			}
		}
	}

	stopReason := mapGeminiFinishReasonToClaudeStopReason(extractGeminiFinishReason(geminiResp))
	if sawToolUse {
		stopReason = "tool_use"
	}

	resp := map[string]any{
		"id":            generateAnthropicMsgID(),
		"type":          "message",
		"role":          "assistant",
		"model":         originalModel,
		"content":       contentBlocks,
		"stop_reason":   stopReason,
		"stop_sequence": nil,
		"usage": map[string]any{
			"input_tokens":  usage.InputTokens,
			"output_tokens": usage.OutputTokens,
		},
	}

	return resp, usage
}

func isGeminiInlineImageMIMEType(mimeType string) bool {
	switch mimeType {
	case "image/gif", "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func isValidBase64(data string) bool {
	if data == "" {
		return false
	}
	_, err := base64.StdEncoding.DecodeString(data)
	return err == nil
}

func extractGeminiUsage(data []byte) *ClaudeUsage {
	usage := gjson.GetBytes(data, "usageMetadata")
	if !usage.Exists() {
		return nil
	}
	prompt := int(usage.Get("promptTokenCount").Int())
	cand := int(usage.Get("candidatesTokenCount").Int())
	cached := int(usage.Get("cachedContentTokenCount").Int())
	thoughts := int(usage.Get("thoughtsTokenCount").Int())

	imageTokens := 0
	candidateDetails := usage.Get("candidatesTokensDetails")
	if candidateDetails.Exists() {
		candidateDetails.ForEach(func(_, detail gjson.Result) bool {
			if detail.Get("modality").String() == "IMAGE" {
				imageTokens = int(detail.Get("tokenCount").Int())
				return false
			}
			return true
		})
	}

	return &ClaudeUsage{
		InputTokens:          max(prompt-cached, 0),
		OutputTokens:         cand + thoughts,
		CacheReadInputTokens: cached,
		ImageOutputTokens:    imageTokens,
	}
}

func asInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int64:
		return int(t), true
	case json.Number:
		i, err := t.Int64()
		if err != nil {
			return 0, false
		}
		return int(i), true
	default:
		return 0, false
	}
}

func ensureGeminiFunctionCallThoughtSignatures(body []byte) []byte {

	if !bytes.Contains(body, []byte(`"functionCall"`)) {
		return body
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}

	contentsAny, ok := payload["contents"].([]any)
	if !ok || len(contentsAny) == 0 {
		return body
	}

	modified := false
	for _, c := range contentsAny {
		cm, ok := c.(map[string]any)
		if !ok {
			continue
		}
		partsAny, ok := cm["parts"].([]any)
		if !ok || len(partsAny) == 0 {
			continue
		}
		for _, p := range partsAny {
			pm, ok := p.(map[string]any)
			if !ok || pm == nil {
				continue
			}
			if fc, ok := pm["functionCall"].(map[string]any); !ok || fc == nil {
				continue
			}
			ts, _ := pm["thoughtSignature"].(string)
			if strings.TrimSpace(ts) == "" {
				pm["thoughtSignature"] = geminiDummyThoughtSignature
				modified = true
			}
		}
	}

	if !modified {
		return body
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return b
}

func extractGeminiFinishReason(geminiResp map[string]any) string {
	if candidates, ok := geminiResp["candidates"].([]any); ok && len(candidates) > 0 {
		if cand, ok := candidates[0].(map[string]any); ok {
			if fr, ok := cand["finishReason"].(string); ok {
				return fr
			}
		}
	}
	return ""
}

func extractGeminiParts(geminiResp map[string]any) []map[string]any {
	if candidates, ok := geminiResp["candidates"].([]any); ok && len(candidates) > 0 {
		if cand, ok := candidates[0].(map[string]any); ok {
			if content, ok := cand["content"].(map[string]any); ok {
				if partsAny, ok := content["parts"].([]any); ok && len(partsAny) > 0 {
					out := make([]map[string]any, 0, len(partsAny))
					for _, p := range partsAny {
						pm, ok := p.(map[string]any)
						if !ok {
							continue
						}
						out = append(out, pm)
					}
					return out
				}
			}
		}
	}
	return nil
}

func computeGeminiTextDelta(seen, incoming string) (delta, newSeen string) {
	incoming = strings.TrimSuffix(incoming, "\u0000")
	if incoming == "" {
		return "", seen
	}

	if strings.HasPrefix(incoming, seen) {
		return strings.TrimPrefix(incoming, seen), incoming
	}

	if strings.HasPrefix(seen, incoming) {
		return "", seen
	}

	return incoming, seen + incoming
}

func mapGeminiFinishReasonToClaudeStopReason(finishReason string) string {
	switch strings.ToUpper(strings.TrimSpace(finishReason)) {
	case "MAX_TOKENS":
		return "max_tokens"
	case "STOP":
		return "end_turn"
	default:
		return "end_turn"
	}
}

func convertClaudeMessagesToGeminiGenerateContent(body []byte) ([]byte, error) {
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, err
	}

	toolUseIDToName := make(map[string]string)

	systemText := extractClaudeSystemText(req["system"])
	contents, err := convertClaudeMessagesToGeminiContents(req["messages"], toolUseIDToName)
	if err != nil {
		return nil, err
	}

	out := make(map[string]any)
	if systemText != "" {
		out["systemInstruction"] = map[string]any{
			"parts": []any{map[string]any{"text": systemText}},
		}
	}
	out["contents"] = contents

	if tools := convertClaudeToolsToGeminiTools(req["tools"]); tools != nil {
		out["tools"] = tools
	}

	generationConfig := convertClaudeGenerationConfig(req)
	if generationConfig != nil {
		out["generationConfig"] = generationConfig
	}

	stripGeminiFunctionIDs(out)
	return json.Marshal(out)
}

func stripGeminiFunctionIDs(req map[string]any) {

	contents, ok := req["contents"].([]any)
	if !ok {
		return
	}
	for _, c := range contents {
		cm, ok := c.(map[string]any)
		if !ok {
			continue
		}
		contentParts, ok := cm["parts"].([]any)
		if !ok {
			continue
		}
		for _, p := range contentParts {
			pm, ok := p.(map[string]any)
			if !ok {
				continue
			}
			if fc, ok := pm["functionCall"].(map[string]any); ok && fc != nil {
				delete(fc, "id")
			}
			if fr, ok := pm["functionResponse"].(map[string]any); ok && fr != nil {
				delete(fr, "id")
			}
		}
	}
}

func extractClaudeSystemText(system any) string {
	switch v := system.(type) {
	case string:
		return strings.TrimSpace(v)
	case []any:
		var parts []string
		for _, p := range v {
			pm, ok := p.(map[string]any)
			if !ok {
				continue
			}
			if t, _ := pm["type"].(string); t != "text" {
				continue
			}
			if text, ok := pm["text"].(string); ok && strings.TrimSpace(text) != "" {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	default:
		return ""
	}
}

func convertClaudeMessagesToGeminiContents(messages any, toolUseIDToName map[string]string) ([]any, error) {
	arr, ok := messages.([]any)
	if !ok {
		return nil, errors.New("messages must be an array")
	}

	out := make([]any, 0, len(arr))
	for _, m := range arr {
		mm, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := mm["role"].(string)
		role = strings.ToLower(strings.TrimSpace(role))
		gRole := "user"
		if role == "assistant" {
			gRole = "model"
		}

		parts := make([]any, 0)
		droppedThinking := false
		switch content := mm["content"].(type) {
		case string:

			parts = append(parts, map[string]any{"text": content})
		case []any:

			singleBlock := len(content) == 1
			var toolImageParts []any

			for _, block := range content {
				bm, ok := block.(map[string]any)
				if !ok {
					continue
				}

				if bt, _ := bm["type"].(string); bt == "thinking" || bt == "redacted_thinking" {
					droppedThinking = true
					continue
				}
				bt, _ := bm["type"].(string)
				switch bt {
				case "text":
					if text, ok := bm["text"].(string); ok {

						if singleBlock || strings.TrimSpace(text) != "" {
							parts = append(parts, map[string]any{"text": text})
						}
					}
				case "tool_use":
					id, _ := bm["id"].(string)
					name, _ := bm["name"].(string)
					if strings.TrimSpace(id) != "" && strings.TrimSpace(name) != "" {
						toolUseIDToName[id] = name
					}
					signature, _ := bm["signature"].(string)
					signature = strings.TrimSpace(signature)
					if signature == "" {
						signature = geminiDummyThoughtSignature
					}
					parts = append(parts, map[string]any{
						"thoughtSignature": signature,
						"functionCall": map[string]any{
							"name": name,
							"args": bm["input"],
						},
					})
				case "tool_result":
					toolUseID, _ := bm["tool_use_id"].(string)
					name := toolUseIDToName[toolUseID]
					if name == "" {
						name = "tool"
					}
					text := extractClaudeContentText(bm["content"])
					images := extractClaudeToolResultImageParts(bm["content"])
					if text == "" && len(images) > 0 {
						text = "[image attached below]"
					}
					parts = append(parts, map[string]any{
						"functionResponse": map[string]any{
							"name": name,
							"response": map[string]any{
								"content": text,
							},
						},
					})
					toolImageParts = append(toolImageParts, images...)
				case "image":
					if src, ok := bm["source"].(map[string]any); ok {
						if srcType, _ := src["type"].(string); srcType == "base64" {
							mediaType, _ := src["media_type"].(string)
							data, _ := src["data"].(string)
							if mediaType != "" && data != "" {
								parts = append(parts, map[string]any{
									"inlineData": map[string]any{
										"mimeType": mediaType,
										"data":     data,
									},
								})
							}
						}
					}
				default:

					if b, err := json.Marshal(bm); err == nil {
						parts = append(parts, map[string]any{"text": string(b)})
					}
				}
			}
			parts = append(parts, toolImageParts...)
		default:

		}

		if droppedThinking && len(parts) == 0 {
			continue
		}

		out = append(out, map[string]any{
			"role":  gRole,
			"parts": parts,
		})
	}
	return out, nil
}

func extractClaudeContentText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, part := range t {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if pm["type"] == "text" {
				if text, ok := pm["text"].(string); ok {
					_, _ = sb.WriteString(text)
				}
			}
		}
		return sb.String()
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func extractClaudeToolResultImageParts(v any) []any {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}

	parts := make([]any, 0)
	for _, part := range arr {
		pm, ok := part.(map[string]any)
		if !ok || pm["type"] != "image" {
			continue
		}
		source, ok := pm["source"].(map[string]any)
		if !ok {
			continue
		}
		if sourceType, _ := source["type"].(string); sourceType != "base64" {
			continue
		}
		mediaType, _ := source["media_type"].(string)
		data, _ := source["data"].(string)
		if mediaType == "" || data == "" {
			continue
		}
		parts = append(parts, map[string]any{
			"inlineData": map[string]any{
				"mimeType": mediaType,
				"data":     data,
			},
		})
	}
	return parts
}

func convertClaudeToolsToGeminiTools(tools any) []any {
	arr, ok := tools.([]any)
	if !ok || len(arr) == 0 {
		return nil
	}

	hasWebSearch := false
	funcDecls := make([]any, 0, len(arr))
	for _, t := range arr {
		tm, ok := t.(map[string]any)
		if !ok {
			continue
		}
		if isClaudeWebSearchToolMap(tm) {
			hasWebSearch = true
			continue
		}

		var name, desc string
		var params any

		toolType, _ := tm["type"].(string)
		if toolType == "custom" {

			custom, ok := tm["custom"].(map[string]any)
			if !ok {
				continue
			}
			name, _ = tm["name"].(string)
			desc, _ = custom["description"].(string)
			params = custom["input_schema"]
		} else {

			name, _ = tm["name"].(string)
			desc, _ = tm["description"].(string)
			params = tm["input_schema"]
		}

		if name == "" {
			continue
		}

		if params == nil {
			params = map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			}
		}

		cleanedParams := cleanToolSchema(params)

		funcDecls = append(funcDecls, map[string]any{
			"name":        name,
			"description": desc,
			"parameters":  cleanedParams,
		})
	}

	out := make([]any, 0, 2)
	if len(funcDecls) > 0 {
		out = append(out, map[string]any{
			"functionDeclarations": funcDecls,
		})
	}
	if hasWebSearch {
		out = append(out, map[string]any{
			"googleSearch": map[string]any{},
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeGeminiRequestForAIStudio(body []byte) []byte {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}

	tools, ok := payload["tools"].([]any)
	if !ok || len(tools) == 0 {
		return body
	}

	modified := false
	for _, rawTool := range tools {
		tool, ok := rawTool.(map[string]any)
		if !ok {
			continue
		}
		googleSearch, ok := tool["googleSearch"]
		if !ok {
			continue
		}
		if _, exists := tool["google_search"]; exists {
			continue
		}
		tool["google_search"] = googleSearch
		delete(tool, "googleSearch")
		modified = true
	}

	if !modified {
		return body
	}

	normalized, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return normalized
}

func isClaudeWebSearchToolMap(tool map[string]any) bool {
	toolType, _ := tool["type"].(string)

	return strings.HasPrefix(toolType, "web_search") || toolType == "google_search"
}

func cleanToolSchema(schema any) any {
	return cleanToolSchemaNode(schema, true)
}

func cleanToolSchemaNode(schema any, schemaNode bool) any {
	if schema == nil {
		return nil
	}

	switch v := schema.(type) {
	case map[string]any:
		if !schemaNode {
			cleaned := make(map[string]any, len(v))
			for key, value := range v {
				cleaned[key] = cleanToolSchemaNode(value, false)
			}
			return cleaned
		}

		cleaned := make(map[string]any)
		for key, value := range v {

			if key == "$schema" || key == "$id" || key == "$ref" ||
				key == "$defs" || key == "definitions" ||
				key == "additionalProperties" || key == "patternProperties" || key == "minLength" ||
				key == "maxLength" || key == "minItems" || key == "maxItems" || key == "exclusiveMinimum" ||
				key == "deprecated" || key == "examples" {
				continue
			}

			switch key {
			case "properties", "dependentSchemas":
				if propertySchemas, ok := value.(map[string]any); ok {
					cleanedProperties := make(map[string]any, len(propertySchemas))
					for propertyName, propertySchema := range propertySchemas {
						cleanedProperties[propertyName] = cleanToolSchemaNode(propertySchema, true)
					}
					cleaned[key] = cleanedProperties
				} else {
					cleaned[key] = cleanToolSchemaNode(value, false)
				}
			case "items", "contains", "propertyNames", "if", "then", "else", "not", "contentSchema",
				"additionalItems", "unevaluatedItems", "unevaluatedProperties":
				cleaned[key] = cleanToolSchemaNode(value, true)
			case "dependencies":
				if dependencies, ok := value.(map[string]any); ok {
					cleanedDependencies := make(map[string]any, len(dependencies))
					for propertyName, dependency := range dependencies {
						if dependencySchema, ok := dependency.(map[string]any); ok {
							cleanedDependencies[propertyName] = cleanToolSchemaNode(dependencySchema, true)
						} else {
							cleanedDependencies[propertyName] = cleanToolSchemaNode(dependency, false)
						}
					}
					cleaned[key] = cleanedDependencies
				} else {
					cleaned[key] = cleanToolSchemaNode(value, false)
				}
			case "anyOf", "allOf", "oneOf", "prefixItems":
				if schemas, ok := value.([]any); ok {
					cleanedSchemas := make([]any, len(schemas))
					for i, childSchema := range schemas {
						cleanedSchemas[i] = cleanToolSchemaNode(childSchema, true)
					}
					cleaned[key] = cleanedSchemas
				} else {
					cleaned[key] = cleanToolSchemaNode(value, false)
				}
			default:
				cleaned[key] = cleanToolSchemaNode(value, false)
			}
		}
		if constValue, exists := v["const"]; exists {
			if stringValue, ok := constValue.(string); ok {
				if originalEnum, hasEnum := v["enum"].([]any); hasEnum {
					intersection := make([]any, 0, 1)
					for _, value := range originalEnum {
						if enumString, ok := value.(string); ok && enumString == stringValue {
							intersection = append(intersection, stringValue)
							break
						}
					}
					cleaned["enum"] = intersection
				} else {
					cleaned["enum"] = []any{stringValue}
				}
				if _, hasType := cleaned["type"]; !hasType {
					cleaned["type"] = "STRING"
				}
			}

			delete(cleaned, "const")
		}
		if enum, ok := cleaned["enum"].([]any); ok {
			if normalized, ok := normalizeGeminiEnum(enum); ok {
				cleaned["enum"] = normalized
			} else {
				delete(cleaned, "enum")
			}
		}

		if typeVal, ok := cleaned["type"].(string); ok {
			cleaned["type"] = strings.ToUpper(typeVal)
		} else if typeValues, ok := cleaned["type"].([]any); ok {
			for _, typeValue := range typeValues {
				typeName, ok := typeValue.(string)
				if ok && !strings.EqualFold(typeName, "null") {
					cleaned["type"] = strings.ToUpper(typeName)
					break
				}
			}
			if _, ok := cleaned["type"].([]any); ok {
				delete(cleaned, "type")
			}
		}
		if cleaned["type"] == "INTEGER" {
			if minimum, ok := incrementIntegralSchemaBound(v["exclusiveMinimum"]); ok {
				if existing, exists := cleaned["minimum"]; !exists || schemaNumberLess(existing, minimum) {
					cleaned["minimum"] = minimum
				}
			}
		}
		return cleaned
	case []any:
		cleaned := make([]any, len(v))
		for i, item := range v {
			cleaned[i] = cleanToolSchemaNode(item, schemaNode)
		}
		return cleaned
	default:
		return v
	}
}

func normalizeGeminiEnum(values []any) ([]any, bool) {
	normalized := make([]any, len(values))
	for i, value := range values {
		if stringValue, ok := value.(string); ok {
			normalized[i] = stringValue
			continue
		}

		switch value.(type) {
		case nil, bool, float32, float64, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, json.Number:
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, false
			}
			normalized[i] = string(encoded)
		default:
			return nil, false
		}
	}
	return normalized, true
}

func incrementIntegralSchemaBound(value any) (any, bool) {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v != math.Trunc(v) || v+1 <= v {
			return nil, false
		}
		return v + 1, true
	case int:
		if v == math.MaxInt {
			return nil, false
		}
		return v + 1, true
	case int64:
		if v == math.MaxInt64 {
			return nil, false
		}
		return v + 1, true
	case json.Number:
		i, err := v.Int64()
		if err != nil || i == math.MaxInt64 {
			return nil, false
		}
		return json.Number(fmt.Sprintf("%d", i+1)), true
	default:
		return nil, false
	}
}

func schemaNumberLess(left, right any) bool {
	leftNumber, leftOK := schemaNumberFloat64(left)
	rightNumber, rightOK := schemaNumberFloat64(right)
	return leftOK && rightOK && leftNumber < rightNumber
}

func schemaNumberFloat64(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil && !math.IsInf(n, 0)
	default:
		return 0, false
	}
}

func convertClaudeGenerationConfig(req map[string]any) map[string]any {
	out := make(map[string]any)
	if mt, ok := asInt(req["max_tokens"]); ok && mt > 0 {
		out["maxOutputTokens"] = mt
	}
	if temp, ok := req["temperature"].(float64); ok {
		out["temperature"] = temp
	}
	if topP, ok := req["top_p"].(float64); ok {
		out["topP"] = topP
	}
	if stopSeq, ok := req["stop_sequences"].([]any); ok && len(stopSeq) > 0 {
		out["stopSequences"] = stopSeq
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

type ClaudeUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreation5mTokens    int
	CacheCreation1hTokens    int
	ImageOutputTokens        int `json:"image_output_tokens,omitempty"`
}
