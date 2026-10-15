package middleware

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestSupabaseManagementBoundary(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		for _, path := range []string{"/api/v1/user/password", "/api/v1/user/totp/status", "/api/v1/user/totp/", "/api/v1/user/passkeys", "/api/v1/user/account-bindings/oidc", "/api/v1/user/auth-identities/bind/start", "/api/v1/user/profile", "/api/v1/admin/users", "/api/v1/user/totp-other"} {
			r := gin.New()
			r.Use(SupabaseManagementBoundary(enabled))
			r.NoRoute(func(c *gin.Context) { c.Status(204) })
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("PUT", path, nil))
			blocked := path != "/api/v1/user/profile" && path != "/api/v1/admin/users" && path != "/api/v1/user/totp-other"
			want := 204
			if enabled && blocked {
				want = 409
			}
			require.Equal(t, want, w.Code, path)
		}
	}
}
