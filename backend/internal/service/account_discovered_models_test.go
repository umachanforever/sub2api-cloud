package service

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestAntigravityDiscoveredModelsReplaceStaleIdentityMappings(t *testing.T) {
	a := &Account{Platform: PlatformAntigravity, Credentials: map[string]any{"model_mapping": map[string]any{"stale": "stale", "alias": "new-model", "gemini-*": "custom"}}, Extra: map[string]any{"upstream_model_ids": []any{"new-model", "gemini-new", "gemini-4-argon-disabled"}}}
	require.Equal(t, map[string]string{"alias": "new-model", "gemini-*": "custom", "new-model": "new-model"}, a.GetModelMapping())
	require.True(t, a.IsModelSupported("new-model"))
	require.False(t, a.IsModelSupported("stale"))
	require.Equal(t, "custom", a.GetMappedModel("gemini-new"))
	require.Equal(t, "custom", a.GetMappedModel("gemini-4-argon-disabled"))
	a.Extra["upstream_model_ids"] = []string{"next-model"}
	require.True(t, a.IsModelSupported("next-model"))
	require.False(t, a.IsModelSupported("new-model"))
}

func TestDiscoveredModelsInvalidSnapshotAndOtherProviders(t *testing.T) {
	for _, snapshot := range []any{nil, []any{}, []any{"fresh", 1}, []string{"bad*"}, []string{"a b"}} {
		a := &Account{Platform: PlatformAntigravity, Credentials: map[string]any{"model_mapping": map[string]any{"kept": "kept"}}, Extra: map[string]any{"upstream_model_ids": snapshot}}
		require.True(t, a.IsModelSupported("kept"))
		require.False(t, a.IsModelSupported("fresh"))
	}
	a := &Account{Platform: PlatformOpenAI, Credentials: map[string]any{"model_mapping": map[string]any{"kept": "kept"}}, Extra: map[string]any{"upstream_model_ids": []string{"fresh"}}}
	require.Equal(t, map[string]string{"kept": "kept"}, a.GetModelMapping())
}
