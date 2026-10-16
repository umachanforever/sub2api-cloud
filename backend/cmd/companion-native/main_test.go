package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/platform/liveattestation"
)

type testProvider struct {
	calls int
	err   error
}

func (p *testProvider) Check(context.Context) error { p.calls++; return p.err }
func (p *testProvider) Generate(context.Context) (string, error) {
	p.calls++
	return "private-device-token", p.err
}

func TestPrivateProtocol(t *testing.T) {
	p := &testProvider{}
	var out bytes.Buffer
	input := "{\"id\":\"one\",\"operation\":\"check\"}\n{\"id\":\"two\",\"operation\":\"attest\"}\n"
	if err := run(context.Background(), strings.NewReader(input), &out, p); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&out)
	var first, second response
	if err := decoder.Decode(&first); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&second); err != nil {
		t.Fatal(err)
	}
	if !first.OK || first.ID != "one" || first.Attestation != "" || !second.OK || second.ID != "two" || second.Attestation != "private-device-token" || p.calls != 2 {
		t.Fatal("incorrect protocol result")
	}
}

func TestRejectsInvalidRequestsWithoutDeviceAccess(t *testing.T) {
	for _, input := range []string{
		`{"id":"x","operation":"attest","extra":true}`,
		`{"id":"x","operation":"attest"} {}`,
		`{"operation":"attest"}`,
		`{"id":"x","operation":"proxy"}`,
		`null`,
	} {
		p := &testProvider{}
		var out bytes.Buffer
		if err := run(context.Background(), strings.NewReader(input+"\n"), &out, p); err != nil {
			t.Fatal(err)
		}
		var result response
		if err := json.Unmarshal(out.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.OK || result.Code == "" || p.calls != 0 {
			t.Fatalf("accepted invalid request %s", input)
		}
	}
}

func TestProviderErrorsDoNotExposeDiagnosticsOrToken(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{liveattestation.ErrUnsupportedPlatform, "unsupported_platform"},
		{liveattestation.ErrChatGPTAppMissing, "chatgpt_app_missing"},
		{errors.New("private-path-and-device-data"), "attestation_unavailable"},
	} {
		var out bytes.Buffer
		if err := run(context.Background(), strings.NewReader("{\"id\":\"x\",\"operation\":\"attest\"}\n"), &out, &testProvider{err: tc.err}); err != nil {
			t.Fatal(err)
		}
		var result response
		if err := json.Unmarshal(out.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.OK || result.Code != tc.code || result.Attestation != "" || strings.Contains(out.String(), "private") {
			t.Fatal("unsafe error response")
		}
	}
}

func TestOversizeAndCancellationDoNotAccessDevice(t *testing.T) {
	p := &testProvider{}
	if err := run(context.Background(), strings.NewReader(strings.Repeat("x", maxRequestBytes+1)), &bytes.Buffer{}, p); err == nil {
		t.Fatal("oversized frame accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := run(ctx, strings.NewReader("{}\n"), &bytes.Buffer{}, p); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation ignored")
	}
	if p.calls != 0 {
		t.Fatal("unexpected device access")
	}
}
