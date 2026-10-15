package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

type SupabaseConfig struct {
	URL            string `mapstructure:"url"`
	PublishableKey string `mapstructure:"publishable_key"`
	JWTIssuer      string `mapstructure:"jwt_issuer"`
}

func (c SupabaseConfig) Enabled() bool {
	return c.URL != "" || c.PublishableKey != "" || c.JWTIssuer != ""
}
func (c SupabaseConfig) Validate() error {
	if !c.Enabled() {
		return nil
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return fmt.Errorf("supabase.url must be an HTTP(S) origin")
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	local := host == "localhost" || host == "host.docker.internal" || host == "kong" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return fmt.Errorf("supabase.url requires HTTPS outside local development")
	}
	if c.PublishableKey == "" || len(c.PublishableKey) > 8192 || strings.ContainsAny(c.PublishableKey, " \r\n\t") {
		return fmt.Errorf("supabase.publishable_key is required")
	}
	if c.JWTIssuer != "" {
		if !strings.HasSuffix(c.JWTIssuer, "/auth/v1") {
			return fmt.Errorf("supabase.jwt_issuer must end with /auth/v1")
		}
		if err := (SupabaseConfig{URL: strings.TrimSuffix(c.JWTIssuer, "/auth/v1"), PublishableKey: c.PublishableKey}).Validate(); err != nil {
			return fmt.Errorf("invalid supabase.jwt_issuer")
		}
	}
	return nil
}

func (c SupabaseConfig) AuthIssuer() string {
	if c.JWTIssuer != "" {
		return c.JWTIssuer
	}
	return strings.TrimRight(c.URL, "/") + "/auth/v1"
}
