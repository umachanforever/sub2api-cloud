package middleware

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestCloudStepUpUsesAuthenticatedAssurance(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name, aal string
		at        int64
		allowed   bool
	}{
		{"fresh", "aal2", time.Now().Unix(), true}, {"old", "aal2", time.Now().Add(-service.StepUpGrantTTL - time.Minute).Unix(), false}, {"future", "aal2", time.Now().Add(time.Minute).Unix(), false}, {"password", "aal1", time.Now().Unix(), false}, {"missing timestamp", "aal2", 0, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			setCloudAssurance(c, &service.JWTClaims{CloudIdentity: true, CloudAAL: test.aal, CloudMFAVerifiedAt: test.at})
			require.Equal(t, test.allowed, cloudStepUp(c))
			if !test.allowed {
				require.Equal(t, 403, w.Code)
			}
		})
	}
}
