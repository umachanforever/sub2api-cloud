//go:build js && wasm

// Code generated from original Sub2API fast policies; DO NOT EDIT.
package main

import (
	domain "github.com/Wei-Shaw/sub2api/internal/domain"
	strings "strings"
)

type Account struct {
	Type     string
	Platform string
}

func normalizeOpenAIServiceTier(raw string) *string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return nil
	}
	if value == "fast" {
		value = "priority"
	}

	switch value {
	case "priority", "flex", "auto", "default", "scale", OpenAIFastTierUltrafast:
		return &value
	default:
		return nil
	}
}

func evaluateOpenAIFastPolicyWithSettings(settings *OpenAIFastPolicySettings, userID int64, account *Account, model, tier string) (action, errMsg string) {
	if settings == nil {
		return BetaPolicyActionPass, ""
	}
	isOAuth := account != nil && account.IsOAuth()
	isBedrock := account != nil && account.IsBedrock()

	for _, userScoped := range []bool{true, false} {
		for _, rule := range settings.Rules {
			if (len(rule.UserIDs) > 0) != userScoped || !openAIFastPolicyUserMatches(rule.UserIDs, userID) {
				continue
			}
			if !betaPolicyScopeMatches(rule.Scope, isOAuth, isBedrock) {
				continue
			}
			ruleTier := strings.ToLower(strings.TrimSpace(rule.ServiceTier))
			if tier == OpenAIFastTierMissing {
				if ruleTier != OpenAIFastTierMissing {
					continue
				}
			} else if ruleTier != "" && ruleTier != OpenAIFastTierAny && ruleTier != tier {
				continue
			}
			eff := BetaPolicyRule{
				Action:               rule.Action,
				ErrorMessage:         rule.ErrorMessage,
				ModelWhitelist:       rule.ModelWhitelist,
				FallbackAction:       rule.FallbackAction,
				FallbackErrorMessage: rule.FallbackErrorMessage,
			}
			return resolveRuleAction(eff, model)
		}
	}
	return BetaPolicyActionPass, ""
}

func openAIFastPolicyUserMatches(ruleUserIDs []int64, userID int64) bool {
	if len(ruleUserIDs) == 0 {
		return true
	}
	for _, ruleUserID := range ruleUserIDs {
		if ruleUserID == userID {
			return true
		}
	}
	return false
}

func betaPolicyScopeMatches(scope string, isOAuth bool, isBedrock bool) bool {
	switch scope {
	case BetaPolicyScopeAll:
		return true
	case BetaPolicyScopeOAuth:
		return isOAuth
	case BetaPolicyScopeAPIKey:
		return !isOAuth && !isBedrock
	case BetaPolicyScopeBedrock:
		return isBedrock
	default:
		return true
	}
}

func matchModelWhitelist(model string, whitelist []string) bool {
	for _, pattern := range whitelist {
		if matchModelPattern(pattern, model) {
			return true
		}
	}
	return false
}

func resolveRuleAction(rule BetaPolicyRule, model string) (action, errorMessage string) {
	if len(rule.ModelWhitelist) == 0 {
		return rule.Action, rule.ErrorMessage
	}
	if matchModelWhitelist(model, rule.ModelWhitelist) {
		return rule.Action, rule.ErrorMessage
	}
	if rule.FallbackAction != "" {
		return rule.FallbackAction, rule.FallbackErrorMessage
	}
	return BetaPolicyActionPass, ""
}

func matchModelPattern(pattern, model string) bool {
	if pattern == model {
		return true
	}

	if strings.HasSuffix(pattern, "*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(model, prefix)
	}

	return false
}

const BetaPolicyActionPass = "pass"

const BetaPolicyScopeAll = "all"

const BetaPolicyScopeOAuth = "oauth"

const BetaPolicyScopeAPIKey = "apikey"

const BetaPolicyScopeBedrock = "bedrock"

type BetaPolicyRule struct {
	BetaToken            string   `json:"beta_token"`
	Action               string   `json:"action"`
	Scope                string   `json:"scope"`
	ErrorMessage         string   `json:"error_message,omitempty"`
	ModelWhitelist       []string `json:"model_whitelist,omitempty"`
	FallbackAction       string   `json:"fallback_action,omitempty"`
	FallbackErrorMessage string   `json:"fallback_error_message,omitempty"`
}

const OpenAIFastTierAny = "all"

const OpenAIFastTierUltrafast = "ultrafast"

const OpenAIFastTierMissing = "missing"

type OpenAIFastPolicyRule struct {
	ServiceTier          string   `json:"service_tier"`
	Action               string   `json:"action"`
	Scope                string   `json:"scope"`
	UserIDs              []int64  `json:"user_ids,omitempty"`
	ErrorMessage         string   `json:"error_message,omitempty"`
	ModelWhitelist       []string `json:"model_whitelist,omitempty"`
	FallbackAction       string   `json:"fallback_action,omitempty"`
	FallbackErrorMessage string   `json:"fallback_error_message,omitempty"`
}

type OpenAIFastPolicySettings struct {
	Rules []OpenAIFastPolicyRule `json:"rules"`
}

func (a *Account) IsOAuth() bool {
	return a.Type == AccountTypeOAuth || a.Type == AccountTypeSetupToken
}

func (a *Account) IsBedrock() bool {
	return a.Platform == PlatformAnthropic && a.Type == AccountTypeBedrock
}

const PlatformAnthropic = domain.PlatformAnthropic

const AccountTypeOAuth = domain.AccountTypeOAuth

const AccountTypeSetupToken = domain.AccountTypeSetupToken

const AccountTypeBedrock = domain.AccountTypeBedrock
