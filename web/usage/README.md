# Cloud usage viewer

Publish this directory as a static site. It does not depend on the local Vue console.

- The browser formats UTC API timestamps using its detected local timezone. The selector can switch to UTC.
- `/api/usage` must proxy to the existing Supabase `/functions/v1/sub2api/v1/usage` endpoint, forwarding Authorization and query parameters. `_redirects` configures this for Netlify. Other hosts need an equivalent rewrite; static hosting without a proxy is insufficient.
- `_headers` configures cache and browser security headers for hosts that support this format.
- Enter a read-only usage token in the form, or open `https://YOUR-HOST/#key=YOUR-USAGE-TOKEN`. The fragment is removed immediately; the token is held only in memory and is never included in published assets.
- Keep the existing cloud JSON endpoint for API clients. Supabase's default Edge Function domain restricts HTML hosting, so a separate web host or a configured custom domain is needed for the browser view.

Do not publish `.local/` or `.env.local`. Only publish this directory.
