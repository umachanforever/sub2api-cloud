package middleware

import (
	"errors"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func abortCloudAuthError(c *gin.Context, err error) bool {
	switch {
	case errors.Is(err, service.ErrServiceUnavailable):
		AbortWithError(c, 503, "AUTH_UNAVAILABLE", "Authentication service unavailable")
	case errors.Is(err, service.ErrCloudMFARequired):
		AbortWithError(c, 403, "MFA_REQUIRED", "Two-factor authentication is required")
	case errors.Is(err, service.ErrUserNotActive):
		AbortWithError(c, 403, "USER_INACTIVE", "User account is not active")
	default:
		return false
	}
	return true
}
func setCloudAssurance(c *gin.Context, claims *service.JWTClaims) {
	if claims.CloudIdentity {
		c.Set("supabase_identity", true)
		c.Set("supabase_aal", claims.CloudAAL)
		c.Set("supabase_mfa_at", claims.CloudMFAVerifiedAt)
	}
}
func cloudStepUp(c *gin.Context) bool {
	at := c.GetInt64("supabase_mfa_at")
	now := time.Now().Unix()
	if c.GetString("supabase_aal") != "aal2" || at <= 0 || at > now || now-at >= int64(service.StepUpGrantTTL/time.Second) {
		AbortWithError(c, 403, "STEP_UP_REQUIRED", "This operation requires recent two-factor verification")
		return false
	}
	return true
}
