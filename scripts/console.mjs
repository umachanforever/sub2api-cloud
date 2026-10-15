import { requestBodyLimit, resolveRequestLimits } from '../supabase/functions/sub2api/request_limits.ts';
import { proxyWebsocket } from "./console-ws.mjs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { serveStatic } from "./static.mjs";
import { createOAuthCallbackServer } from "./oauth-callback.mjs";

import publicSettings from "../supabase/functions/sub2api/public_settings.json" with {type: "json"};
export { publicSettings };

export function validateConfig(input) {
  const url = new URL(input.supabase_url);
  const mode = input.mode ?? "cloud";
  if (!["cloud", "local"].includes(mode)) throw new Error("invalid_supabase_mode");
  const local = mode === "local" && ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(url.hostname) && url.protocol === "http:";
  if (mode === "local" && !local) throw new Error("invalid_supabase_url");
  if (
    (!local && (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || !!url.port)) ||
    url.username || url.password || url.pathname !== "/" || url.search ||
    url.hash
  ) throw new Error("invalid_supabase_url");
  const key = String(input.publishable_key ?? "").trim();
  let valid = /^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key);
  if (!valid && key.split(".").length === 3) {
    try {
      valid =
        JSON.parse(Buffer.from(key.split(".")[1], "base64url")).role === "anon";
    } catch { /* Invalid key. */ }
  }
  if (!valid) throw new Error("public_key_required");
  const management = new URL(input.management_url ?? "http://127.0.0.1:8080");
  if (management.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "management", "host.docker.internal"].includes(management.hostname) ||
      management.username || management.password || management.pathname !== "/" || management.search || management.hash) throw new Error("invalid_management_url");
  return { supabase_url: url.origin, publishable_key: key, management_url: management.origin };
}

export function createConsoleServer({ config, fetchImpl = fetch, staticDir, requestLimits = resolveRequestLimits(process.env) } = {}) {
  const project = config ? validateConfig(config) : null;
  const server = createServer(async (request, response) => {
    const reply = (status, data, message = "") => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({ code: status < 400 ? 0 : status, message, data }),
      );
    };
    try {
      // Vite is a local reverse proxy; direct callers must also be on loopback.
      const host = new URL(`http://${request.headers.host}`).hostname;
      if (
        !["127.0.0.1", "localhost"].includes(host) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) return reply(403, null, "local_origin_required");
      if (request.headers.origin) {
        const origin = new URL(request.headers.origin);
        if (
          origin.protocol !== "http:" ||
          !["127.0.0.1", "localhost"].includes(origin.hostname)
        ) return reply(403, null, "local_origin_required");
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const gatewayPath = /^\/(?:(?:antigravity\/)?(?:v1\/(?:responses(?:\/input_tokens)?|models(?:\/[^/]+)?|chat\/completions|messages(?:\/count_tokens)?|alpha\/search|embeddings|images\/generations|usage)|v1beta\/models(?:\/[^/]+)?)|alpha\/search|messages\/count_tokens|responses(?:\/input_tokens)?|backend-api\/codex\/(?:alpha\/search|models|responses(?:\/input_tokens)?)|models(?:\/[^/]+)?|chat\/completions|embeddings|images\/generations)$/.test(url.pathname);
      if (!gatewayPath && await serveStatic(request, response, url.pathname, staticDir)) return;
      if (
        url.pathname === "/api/v1/settings/public" && request.method === "GET"
      ) { if (!project) return reply(200, publicSettings); }
      if (url.pathname === "/setup/status" && request.method === "GET") {
        return reply(200, { needs_setup: false, step: "completed" });
      }
      if (!project) {
        return reply(
          503,
          null,
          "Configure the Supabase project in .env.local before starting the API proxy.",
        );
      }
      if (
        (!url.pathname.startsWith("/api/v1/") && !gatewayPath) ||
        (/%/.test(url.pathname) && !/^\/api\/v1\/pages\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/images\//.test(url.pathname)) || /\\/.test(url.pathname)
      ) return reply(404, null, "not_found");
      const bodyLimit = gatewayPath ? requestBodyLimit(url.pathname, requestLimits) : 1_048_576;
      if (Number(request.headers["content-length"]) > bodyLimit) {
        request.resume();
        return reply(413, null, "request_too_large");
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > bodyLimit) {
          request.resume();
          return reply(413, null, "request_too_large");
        }
        chunks.push(chunk);
      }
      let payload = Buffer.concat(chunks).toString("utf8");
      const headers = {
        apikey: project.publishable_key,
        "content-type": "application/json",
        "x-s2a-frontend": "1",
      };
      if (request.headers.authorization) {
        headers.authorization = request.headers.authorization;
      }
      for (const name of ["x-api-key", "x-goog-api-key", "anthropic-version", "idempotency-key"]) {
        if (request.headers[name]) headers[name] = request.headers[name];
      }
      let target =
        url.pathname.startsWith("/api/v1/")
          ? `${project.management_url}${url.pathname}${url.search}`
          : `${project.supabase_url}/functions/v1/sub2api${url.pathname}${url.search}`;
      const auth = url.pathname.match(
        /^\/api\/v1\/auth\/(login\/2fa|login|register|forgot-password|reset-password|refresh|logout)$/,
      );
      if (auth && request.method === "POST") {
        const body = payload ? JSON.parse(payload) : {};
        if (auth[1] === "login/2fa") {
          if (typeof body.temp_token !== "string" || !body.temp_token || body.temp_token.length > 16384 ||
              typeof body.totp_code !== "string" || !/^\d{6}$/.test(body.totp_code)) return reply(400, null, "invalid_totp_request");
          headers.authorization = `Bearer ${body.temp_token}`;
          const current = await fetchImpl(`${project.supabase_url}/auth/v1/user`, {
            headers, redirect: "error", signal: AbortSignal.timeout(10_000),
          });
          if (!current.ok) { await current.body?.cancel(); return reply(401, null, "invalid_session"); }
          const identity = await current.json();
          const factor = identity.factors?.find(f => f.factor_type === "totp" && f.status === "verified");
          if (!factor || typeof factor.id !== "string" || !/^[0-9a-f-]{36}$/i.test(factor.id)) return reply(400, null, "totp_not_enabled");
          const challenge = await fetchImpl(`${project.supabase_url}/auth/v1/factors/${factor.id}/challenge`, {
            method: "POST", headers, body: "{}", redirect: "error", signal: AbortSignal.timeout(10_000),
          });
          if (!challenge.ok) { await challenge.body?.cancel(); return reply(challenge.status, null, "mfa_request_rejected"); }
          const challengeData = await challenge.json();
          if (typeof challengeData.id !== "string") return reply(503, null, "invalid_auth_response");
          target = `${project.supabase_url}/auth/v1/factors/${factor.id}/verify`;
          payload = JSON.stringify({ challenge_id: challengeData.id, code: body.totp_code });
        } else if (auth[1] === "login") {
          if (
            typeof body.email !== "string" ||
            typeof body.password !== "string" || !body.email || !body.password
          ) return reply(400, null, "invalid_login");
          target = `${project.supabase_url}/auth/v1/token?grant_type=password`;
          payload = JSON.stringify({
            email: body.email,
            password: body.password,
          });
        } else if (auth[1] === "register") {
          if (
            typeof body.email !== "string" ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
            typeof body.password !== "string" ||
            body.password.length < 6 || body.password.length > 1024
          ) return reply(400, null, "invalid_registration");
          const metadata = {};
          if (typeof body.username === "string" && body.username.trim()) {
            if (body.username.length > 100) return reply(400, null, "invalid_username");
            metadata.username = body.username.trim();
          }
          if (body.invitation_code !== undefined) {
            if (typeof body.invitation_code !== "string" || body.invitation_code.length > 128) return reply(400, null, "invalid_invitation_code");
            metadata.invitation_code = body.invitation_code.trim();
          }
          if (body.promo_code !== undefined) {
            if (typeof body.promo_code !== "string" || body.promo_code.length > 32 || /[\x00-\x1f\x7f]/.test(body.promo_code)) return reply(400, null, "invalid_promo_code");
            metadata.promo_code = body.promo_code.trim();
          }
          target = `${project.supabase_url}/auth/v1/signup?redirect_to=${encodeURIComponent(process.env.SUPABASE_AUTH_SIGNUP_REDIRECT_URL || "http://127.0.0.1:3000/auth/callback")}`;
          payload = JSON.stringify({
            email: body.email.trim(),
            password: body.password,
            ...(Object.keys(metadata).length ? { data: metadata } : {}),
          });
        } else if (auth[1] === "forgot-password") {
          if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
            return reply(400, null, "invalid_email");
          }
          target = `${project.supabase_url}/auth/v1/recover`;
          payload = JSON.stringify({
            email: body.email.trim(),
            redirect_to: process.env.SUPABASE_AUTH_REDIRECT_URL || "http://127.0.0.1:3000/reset-password",
          });
        } else if (auth[1] === "reset-password") {
          if (typeof body.token !== "string" || body.token.length < 20 || body.token.length > 16384 ||
              typeof body.new_password !== "string" || body.new_password.length < 6 || body.new_password.length > 1024) {
            return reply(400, null, "invalid_reset_request");
          }
          target = `${project.supabase_url}/auth/v1/user`;
          headers.authorization = `Bearer ${body.token}`;
          payload = JSON.stringify({ password: body.new_password });
        } else if (auth[1] === "refresh") {
          if (typeof body.refresh_token !== "string" || !body.refresh_token) {
            return reply(400, null, "invalid_refresh_token");
          }
          target =
            `${project.supabase_url}/auth/v1/token?grant_type=refresh_token`;
          payload = JSON.stringify({ refresh_token: body.refresh_token });
        } else {
          target = `${project.supabase_url}/auth/v1/logout`;
          payload = undefined;
        }
      }
      const controller = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      const upstream = await fetchImpl(target, {
        method: request.method,
        headers,
        redirect: "error",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(130_000),
        ]),
        ...(["GET", "HEAD"].includes(request.method) || !payload
          ? {}
          : { body: payload }),
      });
      if (auth) {
        if (!upstream.ok) {
          await upstream.body?.cancel();
          return reply(
            upstream.status,
            null,
            auth[1] === "register"
              ? "Registration failed. Check the email policy and invitation code."
              : "Login failed or the session expired. Check your account and password.",
          );
        }
        if (auth[1] === "logout") {
          await upstream.body?.cancel();
          return reply(200, { message: "logged_out" });
        }
        if (auth[1] === "forgot-password") {
          await upstream.body?.cancel();
          return reply(200, { message: "Password reset email sent." });
        }
        if (auth[1] === "reset-password") {
          await upstream.body?.cancel();
          return reply(200, { message: "Password reset successfully." });
        }
        const session = await upstream.json();
        if (auth[1] === "register" &&
            (typeof session.access_token !== "string" || typeof session.refresh_token !== "string")) {
          return reply(202, { requires_email_verification: true }, "Check your email to finish registration.");
        }
        if (typeof session.access_token !== "string" || typeof session.refresh_token !== "string" ||
            typeof session.expires_in !== "number") return reply(503, null, "invalid_auth_response");
        if (auth[1] === "login") {
          const current = await fetchImpl(`${project.supabase_url}/auth/v1/user`, {
            headers: { ...headers, authorization: `Bearer ${session.access_token}` },
            redirect: "error", signal: AbortSignal.timeout(10_000),
          });
          if (!current.ok) { await current.body?.cancel(); return reply(current.status, null, "invalid_session"); }
          const identity = await current.json();
          if (identity.factors?.some(f => f.factor_type === "totp" && f.status === "verified")) {
            return reply(200, { requires_2fa: true, temp_token: session.access_token, user_email_masked: "***" });
          }
        }
        const me = await fetchImpl(
          `${project.management_url}/api/v1/auth/me`,
          {
            headers: {
              ...headers,
              authorization: `Bearer ${session.access_token}`,
            },
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
          },
        );
        if (!me.ok) {
          await me.body?.cancel();
          return reply(
            me.status,
            null,
            "Login verified, but management could not load the user. Check the Go service and identity mapping.",
          );
        }
        const profile = await me.json();
        return reply(200, {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_in: session.expires_in,
          token_type: session.token_type,
          user: profile.data,
        });
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ??
          "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        ...(upstream.headers.has("content-security-policy") ? {"content-security-policy": upstream.headers.get("content-security-policy")} : {}),
      });
      if (upstream.body) {
        await pipeline(Readable.fromWeb(upstream.body), response);
      } else response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      reply(
        error instanceof SyntaxError || error instanceof TypeError ? 400 : 502,
        null,
        "console_request_failed",
      );
    }
  });
  server.on("upgrade", (request, socket, head) => proxyWebsocket(request, socket, head, project));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

if (import.meta.main) {
  const config =
    process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY
      ? {
        supabase_url: process.env.SUPABASE_URL,
        mode: process.env.SUPABASE_MODE ?? "cloud",
        publishable_key: process.env.SUPABASE_PUBLISHABLE_KEY,
        management_url: process.env.MANAGEMENT_URL,
      }
      : undefined;
  try {
    const server = createConsoleServer({ config, staticDir: process.env.CONSOLE_STATIC_DIR });
    const callback = createOAuthCallbackServer();
    callback.on("error", () => console.error("Local OAuth callback port 1455 is unavailable; copy the browser callback URL to complete authorization."));
    callback.listen(1455, process.env.CONSOLE_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1");
    server.on("error", () => {
      console.error("Local API proxy port 4173 is unavailable");
      process.exitCode = 1;
    });
    server.listen(
      4173,
      process.env.CONSOLE_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
      () => console.log("sub2api-cloud local API proxy: http://127.0.0.1:4173"),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
