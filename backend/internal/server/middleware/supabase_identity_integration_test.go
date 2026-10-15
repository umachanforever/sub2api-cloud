//go:build unit

package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/DATA-DOG/go-sqlmock"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestSupabaseAdminUsesCurrentBusinessRole(t *testing.T) {
	gin.SetMode(gin.TestMode)
	subject := uuid.NewString()
	now := time.Now()
	authCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authCalls++
		_ = json.NewEncoder(w).Encode(map[string]any{"id": subject})
	}))
	defer server.Close()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer db.Close()
	client := dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db)))
	user := &service.User{ID: 7, Role: service.RoleAdmin, Status: service.StatusActive, Concurrency: 2, TokenVersion: 4}
	repo := &stubUserRepo{getByID: func(context.Context, int64) (*service.User, error) { copy := *user; return &copy, nil }}
	cfg := &config.Config{Supabase: config.SupabaseConfig{URL: server.URL, PublishableKey: "public-fixture"}}
	auth := service.NewAuthService(client, repo, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	users := service.NewUserService(repo, nil, nil, nil)
	claims := jwt.MapClaims{"sub": subject, "iss": server.URL + "/auth/v1", "aud": "authenticated", "role": "authenticated", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(), "session_id": uuid.NewString(), "aal": "aal1"}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("fixture"))
	require.NoError(t, err)
	router := gin.New()
	router.Use(gin.HandlerFunc(NewAdminAuthMiddleware(auth, users, nil, nil)))
	router.GET("/admin", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	for _, test := range []struct {
		role, status string
		want         int
	}{{service.RoleAdmin, service.StatusActive, 200}, {service.RoleUser, service.StatusActive, 403}, {service.RoleAdmin, service.StatusDisabled, 401}} {
		user.Role = test.role
		user.Status = test.status
		mock.ExpectQuery("SELECT .*auth_identities").WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "provider_type", "provider_key", "provider_subject", "verified_at"}).AddRow(1, 7, "oidc", server.URL+"/auth/v1", subject, now))
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/admin", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		router.ServeHTTP(w, req)
		require.Equal(t, test.want, w.Code, w.Body.String())
	}
	require.Equal(t, 3, authCalls)
	require.NoError(t, mock.ExpectationsWereMet())
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/admin", nil)
	req.Header.Set("x-api-key", "legacy-admin-key")
	router.ServeHTTP(w, req)
	require.Equal(t, 401, w.Code)
	require.Equal(t, 3, authCalls)
}
