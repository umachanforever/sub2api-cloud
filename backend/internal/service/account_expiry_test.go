package service

import (
	"encoding/json"
	"testing"
	"time"
)

func TestAccountCredentialExpiryFormats(t *testing.T) {
	expected := time.UnixMilli(1800000000123).UTC()
	for _, value := range []any{expected.Format(time.RFC3339Nano), "1800000000123", int64(1800000000123), float64(1800000000123), json.Number("1800000000123")} {
		account := &Account{Credentials: map[string]any{"expires_at": value}}
		actual := account.GetCredentialAsTime("expires_at")
		if actual == nil || !actual.Equal(expected) {
			t.Errorf("expiry %T: expected %v, got %v", value, expected, actual)
		}
	}
	for _, value := range []any{"1800000000", int64(1800000000), json.Number("1800000000")} {
		account := &Account{Credentials: map[string]any{"expires_at": value}}
		actual := account.GetCredentialAsTime("expires_at")
		if actual == nil || !actual.Equal(time.Unix(1800000000, 0)) {
			t.Errorf("seconds expiry %T was not preserved", value)
		}
	}
}
