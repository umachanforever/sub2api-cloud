package service

import "strings"

func optionalTrimmedStringPtr(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

// coalesceRequestedReasoningEffort prefers the client-requested value and falls
// back to the effective/forwarded effort for historical or unmapped rows.
func coalesceRequestedReasoningEffort(requested, forwarded *string) *string {
	if trimmed := optionalStringValue(requested); trimmed != "" {
		return &trimmed
	}
	if trimmed := optionalStringValue(forwarded); trimmed != "" {
		return &trimmed
	}
	return nil
}

func forwardResultBillingModel(requestedModel, upstreamModel string) string {
	if trimmed := strings.TrimSpace(requestedModel); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(upstreamModel)
}

func optionalInt64Ptr(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}

// openAIUsageBillingModels keeps model-source precedence and fallback ordering shared with Edge pricing.
func openAIUsageBillingModels(resultModel, explicitModel, originalModel, channelModel, upstreamModel, source string) []string {
	billingModel := forwardResultBillingModel(resultModel, upstreamModel)
	if explicitModel != "" {
		billingModel = strings.TrimSpace(explicitModel)
	}
	if source == BillingModelSourceChannelMapped && channelModel != "" && channelModel != originalModel {
		billingModel = channelModel
	}
	if source == BillingModelSourceRequested && originalModel != "" {
		billingModel = originalModel
	}
	return usageBillingModelCandidates(billingModel, explicitModel, channelModel, originalModel, upstreamModel, resultModel)
}
