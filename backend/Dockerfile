ARG GO_IMAGE=golang:1.27.2-alpine
ARG RUNTIME_IMAGE=postgres:18-alpine
FROM ${GO_IMAGE} AS build
WORKDIR /build
ARG GOPROXY=https://proxy.golang.org,direct
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod GOPROXY="${GOPROXY}" go mod download
COPY . .
ARG VERSION=0.3.0
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOPROXY="${GOPROXY}" GOMEMLIMIT=768MiB GOGC=25 GOMAXPROCS=1 CGO_ENABLED=0 go build -p 1 -trimpath -ldflags="-s -w -X main.Version=${VERSION} -X main.BuildType=release" -o /management ./cmd/server

FROM ${RUNTIME_IMAGE}
RUN addgroup -S management && adduser -S -G management management && \
    mkdir -p /app/data /app/resources/model-pricing && chown -R management:management /app
WORKDIR /app
COPY --from=build /management /usr/local/bin/management
COPY --chown=management:management resources/model-pricing/model_prices_and_context_window.json /app/resources/model-pricing/model_prices_and_context_window.json
ENV DATA_DIR=/app/data SERVER_HOST=0.0.0.0 SERVER_PORT=8080 SERVER_MODE=release
USER management
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["management"]
