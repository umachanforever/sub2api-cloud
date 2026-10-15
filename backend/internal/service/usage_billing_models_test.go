package service

import (
	"reflect"
	"testing"
)

func TestOpenAIUsageBillingModels(t *testing.T) {
	tests := []struct {
		name, result, explicit, original, channel, upstream, source string
		want                                                        []string
	}{
		{"concrete baseline", "concrete", "", "alias", "alias", "upstream", "", []string{"concrete", "alias", "upstream"}},
		{"explicit baseline", "concrete", " explicit ", "alias", "alias", "upstream", BillingModelSourceUpstream, []string{"explicit", "alias", "upstream", "concrete"}},
		{"requested source", "concrete", "explicit", "alias", "mapped", "upstream", BillingModelSourceRequested, []string{"alias", "explicit", "mapped", "upstream", "concrete"}},
		{"channel source", "concrete", "explicit", "alias", "mapped", "upstream", BillingModelSourceChannelMapped, []string{"mapped", "explicit", "alias", "upstream", "concrete"}},
		{"unchanged channel retains concrete", "concrete", "", "alias", "alias", "upstream", BillingModelSourceChannelMapped, []string{"concrete", "alias", "upstream"}},
		{"empty result falls back", "", "", "alias", "", "upstream", BillingModelSourceUpstream, []string{"upstream", "alias"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := openAIUsageBillingModels(tt.result, tt.explicit, tt.original, tt.channel, tt.upstream, tt.source)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}
