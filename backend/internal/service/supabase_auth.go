package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/authidentity"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var ErrCloudMFARequired = infraerrors.Forbidden("MFA_REQUIRED", "Two-factor authentication is required")
var cloudAuthHTTP = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

type supabaseTokenClaims struct {
	jwt.RegisteredClaims
	SessionID string `json:"session_id"`
	Role      string `json:"role"`
	AAL       string `json:"aal"`
	AMR       []struct {
		Method    string `json:"method"`
		Timestamp int64  `json:"timestamp"`
	} `json:"amr"`
}

type supabaseAuthUser struct {
	ID          string     `json:"id"`
	BannedUntil *time.Time `json:"banned_until"`
	Factors     []struct {
		Type   string `json:"factor_type"`
		Status string `json:"status"`
	} `json:"factors"`
}

func (s *AuthService) CloudIdentityEnabled() bool {
	return s != nil && s.cfg != nil && s.cfg.Supabase.Enabled()
}

// ValidateManagementToken keeps cloud identity separate from locally signed tokens.
func (s *AuthService) ValidateManagementToken(ctx context.Context, token string) (*JWTClaims, error) {
	if !s.CloudIdentityEnabled() {
		return s.ValidateToken(token)
	}
	if token == "" || len(token) > maxTokenLength {
		return nil, ErrInvalidToken
	}
	if s.cfg.Supabase.Validate() != nil {
		return nil, ErrServiceUnavailable
	}
	origin := strings.TrimRight(s.cfg.Supabase.URL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/auth/v1/user", nil)
	if err != nil {
		return nil, ErrServiceUnavailable
	}
	req.Header.Set("apikey", s.cfg.Supabase.PublishableKey)
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := cloudAuthHTTP.Do(req)
	if err != nil {
		return nil, ErrServiceUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode >= 500 || response.StatusCode == 429 || response.StatusCode >= 300 && response.StatusCode < 400 {
			return nil, ErrServiceUnavailable
		}
		return nil, ErrInvalidToken
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 128*1024+1))
	if err != nil || len(data) > 128*1024 {
		return nil, ErrServiceUnavailable
	}
	var actor supabaseAuthUser
	if json.Unmarshal(data, &actor) != nil {
		return nil, ErrServiceUnavailable
	}
	subject, err := uuid.Parse(actor.ID)
	if err != nil || subject == uuid.Nil || subject.String() != actor.ID {
		return nil, ErrInvalidToken
	}
	if actor.BannedUntil != nil && actor.BannedUntil.After(time.Now()) {
		return nil, ErrUserNotActive
	}
	// Auth has verified the signature; inspect assurance and issuer only after that check.
	var claims supabaseTokenClaims
	if _, _, err = jwt.NewParser().ParseUnverified(token, &claims); err != nil {
		return nil, ErrInvalidToken
	}
	now := time.Now()
	if claims.Subject != actor.ID || claims.Issuer != s.cfg.Supabase.AuthIssuer() || claims.Role != "authenticated" || claims.ExpiresAt == nil || !claims.ExpiresAt.After(now) || claims.NotBefore != nil && claims.NotBefore.After(now) || claims.IssuedAt == nil || claims.IssuedAt.After(now.Add(time.Minute)) {
		return nil, ErrInvalidToken
	}
	audience := false
	for _, value := range claims.Audience {
		if value == "authenticated" {
			audience = true
		}
	}
	if !audience {
		return nil, ErrInvalidToken
	}
	session, err := uuid.Parse(claims.SessionID)
	if err != nil || session == uuid.Nil {
		return nil, ErrInvalidToken
	}
	for _, factor := range actor.Factors {
		if factor.Type == "totp" && factor.Status == "verified" && claims.AAL != "aal2" {
			return nil, ErrCloudMFARequired
		}
	}
	if s.entClient == nil {
		return nil, ErrServiceUnavailable
	}
	identity, err := s.entClient.AuthIdentity.Query().Where(authidentity.ProviderTypeEQ("oidc"), authidentity.ProviderKeyEQ(s.cfg.Supabase.AuthIssuer()), authidentity.ProviderSubjectEQ(actor.ID), authidentity.VerifiedAtNotNil()).Only(ctx)
	if dbent.IsNotFound(err) {
		return nil, ErrInvalidToken
	}
	if err != nil {
		return nil, ErrServiceUnavailable
	}
	result := &JWTClaims{UserID: identity.UserID, SessionID: session.String(), CloudIdentity: true, CloudAAL: claims.AAL, RegisteredClaims: claims.RegisteredClaims}
	for _, method := range claims.AMR {
		if method.Method == "totp" || method.Method == "mfa/totp" {
			if method.Timestamp <= now.Unix() && method.Timestamp > result.CloudMFAVerifiedAt {
				result.CloudMFAVerifiedAt = method.Timestamp
			}
		}
	}
	return result, nil
}
