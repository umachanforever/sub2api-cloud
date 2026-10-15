package config

import "testing"

func TestSupabaseConfigBoundary(t *testing.T) {
	for _, test := range []struct {
		url, key string
		valid    bool
	}{
		{"", "", true}, {"https://project.supabase.co", "public", true}, {"http://127.0.0.1:54321", "public", true}, {"http://host.docker.internal:54321", "public", true},
		{"http://public.example.com", "public", false}, {"https://user:secret@example.com", "public", false}, {"https://example.com/path", "public", false}, {"https://example.com?query=1", "public", false}, {"https://example.com", "", false}, {"", "public", false}, {"https://example.com", "key\r\nvalue", false},
	} {
		t.Run(test.url+test.key, func(t *testing.T) {
			err := (SupabaseConfig{URL: test.url, PublishableKey: test.key}).Validate()
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v: %v", test.valid, err)
			}
		})
	}
}

func TestSupabasePrivateAuthEndpointHasExplicitIssuer(t *testing.T) {
	c := SupabaseConfig{URL: "http://kong:8000", PublishableKey: "public", JWTIssuer: "http://127.0.0.1:54321/auth/v1"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if c.AuthIssuer() != "http://127.0.0.1:54321/auth/v1" {
		t.Fatal("issuer changed to private transport address")
	}
	c.JWTIssuer = "https://project.supabase.co/incorrect"
	if c.Validate() == nil {
		t.Fatal("invalid issuer accepted")
	}
}
