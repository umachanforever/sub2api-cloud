// companion-native exposes the original platform provider over a private stdio pipe.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/Wei-Shaw/sub2api/internal/platform/liveattestation"
)

const maxRequestBytes = 4096

type request struct {
	ID        string `json:"id"`
	Operation string `json:"operation"`
}

type response struct {
	ID          string `json:"id,omitempty"`
	OK          bool   `json:"ok"`
	Attestation string `json:"attestation,omitempty"`
	Code        string `json:"code,omitempty"`
}

func run(ctx context.Context, input io.Reader, output io.Writer, provider liveattestation.Provider) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 1024), maxRequestBytes)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var req request
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		err := decoder.Decode(&req)
		var trailing any
		if err != nil || decoder.Decode(&trailing) != io.EOF || req.ID == "" || len(req.ID) > 128 {
			if err := encoder.Encode(response{Code: "invalid_request"}); err != nil {
				return err
			}
			continue
		}
		result := response{ID: req.ID}
		switch req.Operation {
		case "check":
			err = provider.Check(ctx)
		case "attest":
			result.Attestation, err = provider.Generate(ctx)
			if err == nil && result.Attestation == "" {
				err = errors.New("empty attestation")
			}
		default:
			result.Code = "unsupported_operation"
		}
		if err != nil {
			result.Attestation = ""
			switch {
			case errors.Is(err, liveattestation.ErrUnsupportedPlatform):
				result.Code = "unsupported_platform"
			case errors.Is(err, liveattestation.ErrChatGPTAppMissing):
				result.Code = "chatgpt_app_missing"
			case ctx.Err() != nil:
				result.Code = "cancelled"
			default:
				result.Code = "attestation_unavailable"
			}
		}
		result.OK = result.Code == ""
		if err := encoder.Encode(result); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Closing stdin unblocks an idle worker when its parent terminates the session.
	go func() { <-ctx.Done(); _ = os.Stdin.Close() }()
	if err := run(ctx, os.Stdin, os.Stdout, liveattestation.NewProvider()); err != nil && ctx.Err() == nil {
		_, _ = io.WriteString(os.Stderr, "companion native protocol failed\n")
		os.Exit(1)
	}
}
