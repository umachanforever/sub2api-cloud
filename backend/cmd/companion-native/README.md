# Native companion worker

This worker reuses the original Go DeviceCheck provider for the optional local
companion. It communicates over inherited standard input and output, with one
JSON request and response per line. It opens no network listener and requires no
database, Redis, Supabase service-role key, or Docker daemon.

Build from `backend`:

```sh
go build -o companion-native ./cmd/companion-native
```

The parent process launches the worker with private pipes. Requests contain an
`id` (1–128 bytes) and an `operation` (`check` or `attest`). The maximum request
frame is 4 KiB. Responses echo the ID, include `ok`, and return either an
`attestation` for a successful `attest` request or a stable error `code`. Unknown
fields, trailing JSON values, and unsupported operations are rejected without
accessing the device provider. Closing input exits the worker; SIGINT and SIGTERM
cancel active provider work and close idle input.

`check` verifies the platform and official ChatGPT application runtime without
generating a token. `attest` generates a real DeviceCheck token using that runtime.
DeviceCheck requires Apple Silicon macOS and the official ChatGPT application;
Linux containers cannot supply this capability. Provider diagnostics are reduced
to error codes to avoid exposing local paths or device data.

Attestation responses are credentials. The parent must consume them directly,
exclude them from logs and telemetry, and terminate the worker when the companion
shuts down. Do not attach its output to a terminal, web endpoint, or log collector.
