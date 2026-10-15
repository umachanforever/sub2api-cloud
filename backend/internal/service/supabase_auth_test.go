//go:build unit

package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestSupabaseManagementIdentity(t *testing.T) {
	ctx := context.Background()
	client := newAdminServiceAuthIdentityBindingTestClient(t)
	user, err := client.User.Create().SetEmail("mapped@example.com").SetPasswordHash("unused").Save(ctx)
	require.NoError(t, err)
	subject := uuid.NewString()
	now := time.Now()
	mfa := false
	status := 200
	body := ""
	seen := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen++
		require.Equal(t, "/auth/v1/user", r.URL.Path)
		require.Equal(t, "public-fixture", r.Header.Get("apikey"))
		require.True(t, strings.HasPrefix(r.Header.Get("Authorization"), "Bearer "))
		w.WriteHeader(status)
		if body != "" {
			_, _ = w.Write([]byte(body))
			return
		}
		factors := []map[string]string{}
		if mfa {
			factors = append(factors, map[string]string{"factor_type": "totp", "status": "verified"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": subject, "factors": factors})
	}))
	defer server.Close()
	cfg := &config.Config{Supabase: config.SupabaseConfig{URL: server.URL, PublishableKey: "public-fixture"}}
	svc := &AuthService{cfg: cfg, entClient: client}
	identity, err := client.AuthIdentity.Create().SetUserID(user.ID).SetProviderType("oidc").SetProviderKey(server.URL + "/auth/v1").SetProviderSubject(subject).SetVerifiedAt(now).Save(ctx)
	require.NoError(t, err)
	token := func(update func(jwt.MapClaims)) string {
		claims := jwt.MapClaims{"sub": subject, "iss": server.URL + "/auth/v1", "aud": "authenticated", "role": "authenticated", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(), "session_id": uuid.NewString(), "aal": "aal1"}
		if update != nil {
			update(claims)
		}
		raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("fixture"))
		require.NoError(t, err)
		return raw
	}
	claims, err := svc.ValidateManagementToken(ctx, token(nil))
	require.NoError(t, err)
	require.Equal(t, user.ID, claims.UserID)
	require.True(t, claims.CloudIdentity)
	require.Empty(t, claims.Role)
	t.Run("rejected sessions never fall back to local JWT", func(t *testing.T) {
		status = 401
		defer func() { status = 200 }()
		_, err := svc.ValidateManagementToken(ctx, token(nil))
		require.ErrorIs(t, err, ErrInvalidToken)
	})
	t.Run("network failures remain service failures", func(t *testing.T) {
		status = 503
		defer func() { status = 200 }()
		_, err := svc.ValidateManagementToken(ctx, token(nil))
		require.ErrorIs(t, err, ErrServiceUnavailable)
	})
	for _, field := range []string{"sub", "iss", "aud", "role", "session_id", "exp"} {
		t.Run("reject "+field, func(t *testing.T) {
			_, err := svc.ValidateManagementToken(ctx, token(func(c jwt.MapClaims) { c[field] = "invalid" }))
			require.ErrorIs(t, err, ErrInvalidToken)
		})
	}
	t.Run("MFA assurance is enforced and carries authenticated timestamps", func(t *testing.T) {
		mfa = true
		defer func() { mfa = false }()
		_, err := svc.ValidateManagementToken(ctx, token(nil))
		require.ErrorIs(t, err, ErrCloudMFARequired)
		claims, err := svc.ValidateManagementToken(ctx, token(func(c jwt.MapClaims) {
			c["aal"] = "aal2"
			c["amr"] = []map[string]any{{"method": "mfa/totp", "timestamp": now.Unix()}, {"method": "totp", "timestamp": now.Add(time.Hour).Unix()}}
		}))
		require.NoError(t, err)
		require.Equal(t, now.Unix(), claims.CloudMFAVerifiedAt)
	})
	t.Run("responses are bounded and never echo secrets", func(t *testing.T) {
		body = strings.Repeat("private", 22000)
		defer func() { body = "" }()
		_, err := svc.ValidateManagementToken(ctx, token(nil))
		require.ErrorIs(t, err, ErrServiceUnavailable)
		require.NotContains(t, err.Error(), "private")
	})
	t.Run("no identity is automatically linked by email", func(t *testing.T) {
		require.NoError(t, client.AuthIdentity.DeleteOneID(identity.ID).Exec(ctx))
		_, err := svc.ValidateManagementToken(ctx, token(nil))
		require.ErrorIs(t, err, ErrInvalidToken)
	})
	t.Run("oversized tokens never leave process", func(t *testing.T) {
		before := seen
		_, err := svc.ValidateManagementToken(ctx, strings.Repeat("a", 8193))
		require.ErrorIs(t, err, ErrInvalidToken)
		require.Equal(t, before, seen)
	})
	t.Run("cloud-only flags cannot be injected into native JWT claims", func(t *testing.T) {
		var c JWTClaims
		require.NoError(t, json.Unmarshal([]byte(`{"CloudIdentity":true,"CloudAAL":"aal2","CloudMFAVerifiedAt":123}`), &c))
		require.False(t, c.CloudIdentity)
		require.Empty(t, c.CloudAAL)
	})
	t.Run("malformed authenticated response is rejected", func(t *testing.T) {
		body = "invalid private response"
		defer func() { body = "" }()
		_, err := svc.ValidateManagementToken(ctx, token(nil))
		require.ErrorIs(t, err, ErrServiceUnavailable)
	})
}

func TestSupabaseLiveIdentity(t *testing.T) {
	token := os.Getenv("S2A_AUTH_ACCEPTANCE_TOKEN")
	if token == "" {
		t.Skip("Set S2A_AUTH_ACCEPTANCE_* to verify an existing local Supabase session")
	}
	ctx := context.Background()
	client := newAdminServiceAuthIdentityBindingTestClient(t)
	user, err := client.User.Create().SetEmail("live-identity@example.com").SetPasswordHash("unused").Save(ctx)
	require.NoError(t, err)
	cfg := &config.Config{Supabase: config.SupabaseConfig{URL: os.Getenv("S2A_AUTH_ACCEPTANCE_URL"), PublishableKey: os.Getenv("S2A_AUTH_ACCEPTANCE_PUBLIC_KEY"), JWTIssuer: os.Getenv("S2A_AUTH_ACCEPTANCE_ISSUER")}}
	_, err = client.AuthIdentity.Create().SetUserID(user.ID).SetProviderType("oidc").SetProviderKey(cfg.Supabase.AuthIssuer()).SetProviderSubject(os.Getenv("S2A_AUTH_ACCEPTANCE_SUBJECT")).SetVerifiedAt(time.Now()).Save(ctx)
	require.NoError(t, err)
	claims, err := (&AuthService{cfg: cfg, entClient: client}).ValidateManagementToken(ctx, token)
	require.NoError(t, err)
	require.Equal(t, user.ID, claims.UserID)
	require.True(t, claims.CloudIdentity)
}
