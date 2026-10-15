package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// Prevent native credential handlers from creating a second identity authority.
func SupabaseManagementBoundary(enabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		path := strings.TrimSuffix(c.Request.URL.Path, "/")
		if enabled && (path == "/api/v1/user/password" ||
			path == "/api/v1/user/totp" || strings.HasPrefix(path, "/api/v1/user/totp/") ||
			path == "/api/v1/user/passkeys" || strings.HasPrefix(path, "/api/v1/user/passkeys/") ||
			path == "/api/v1/user/account-bindings" || strings.HasPrefix(path, "/api/v1/user/account-bindings/") ||
			path == "/api/v1/user/auth-identities" || strings.HasPrefix(path, "/api/v1/user/auth-identities/")) {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"code": "cloud_identity_required", "message": "Use Supabase Auth for identity operations"})
			return
		}
		c.Next()
	}
}
