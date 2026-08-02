# Context for Claude

An MCP server fronting a self-hosted [ConvertX](https://github.com/C4illin/ConvertX).
`README.md` covers installation; this file covers what a session needs to know
before changing the code.

## Ground rule

**ConvertX is never modified.** No forks, no patches, no plugins — it runs as the
stock `ghcr.io/c4illin/convertx` image. Any fix belongs on this side of the wire.

## Outstanding work: the vault / sync-session seam

**This is the main open task.** Two components were built without access to the
house conventions they were supposed to follow, and are expected to be replaced:

| File | What it does now | What it needs |
| --- | --- | --- |
| `src/vault/index.ts` | Secret resolution: `<NAME>_FILE` beats `<NAME>`, cached, resolved values registered with a redactor | Swap for the real vault framework |
| `src/convertx/session.ts` | `SyncSession` — single-flight login, cookie jar, per-job session isolation | Reconcile with the real `sync-session` skill |

Both were written from scratch because `sync-session` and `vault` returned zero
hits across every repository on the account — the skill lives locally on the
owner's Mac, not in any repo. The names were chosen to match the requested
concepts, but **the implementations are not the house ones** and should not be
assumed to match its API, lifecycle, or semantics.

They are deliberately isolated so swapping them is contained:

- Everything reads secrets through `Vault.get()` / `Vault.require()`; nothing
  else touches `process.env` for a credential.
- `ConvertXClient` depends on `SyncSession` only via `request()`, `newJob()`,
  `ensureAuthenticated()` and `forJob()`. Preserve those four and the client is
  unaffected.

Before rewriting `session.ts`, read "Why the session layer looks like this"
below — two of its behaviours are forced by ConvertX and must survive any
refactor, whatever framework replaces it.

## Architecture

```
src/
  index.ts            entry point; stdio + HTTP transports, signal handling
  server.ts           wires config -> client + tools -> McpServer
  config.ts           env parsing (zod), pulls credentials through the vault
  files.ts            path sandboxing for reads/writes
  constants.ts        response + inline-content limits
  vault/index.ts      secret providers, redactor        <- see above
  convertx/
    session.ts        cookie/auth lifecycle             <- see above
    client.ts         the five-step conversion workflow
    parse.ts          HTML parsers for ConvertX's responses
    cookies.ts        minimal cookie jar, JWT id extraction
    errors.ts         typed errors with actionable messages
  tools/index.ts      the three MCP tools
```

## Why the session layer looks like this

ConvertX has **no REST API**. It is server-rendered JSX with JWT cookie auth, so
a conversion is five browser-shaped steps: `GET /` (allocates a job via the
`jobId` cookie) → `POST /upload` (multipart, field name `file`) → `POST /convert`
(`convert_to=<target>,<converter>`, `file_names` as a JSON string) → `POST
/progress/:jobId` (HTML fragment) → `GET /download/:userId/:jobId/:name`.

Three constraints are load-bearing. Breaking any of them produces failures that
look like something else entirely:

1. **Completion is signalled by markup.** ConvertX renders a `value` attribute on
   its `<progress>` element only once every expected file exists. There is no
   status field to poll. `parseJobProgress` keys off that attribute; per-file
   status text is informational only.

2. **Anonymous mode reassigns identity on every `GET /`.** With
   `ALLOW_UNAUTHENTICATED=true` and `UNAUTHENTICATED_USER_SHARING=false`, each
   visit to `/` mints a *new random user id*. Sharing one cookie jar across jobs
   silently orphans earlier jobs — their files exist but `/download/:userId/...`
   no longer matches. Hence `forJob()`: one isolated session per job when
   anonymous, one shared session when authenticated.

3. **Login must be single-flight.** Concurrent tool calls each performing their
   own `POST /login` would let the last `Set-Cookie` invalidate jobs the others
   had already started. `ensureAuthenticated()` collapses concurrent callers onto
   one in-flight login.

Parsers target `data-*` attributes and `href`s — the things ConvertX's own
client-side JS depends on. They deliberately never match Tailwind classes.

## Testing

```bash
npm run verify   # format check, lint, typecheck, unit tests + coverage
```

Unit tests run against `tests/fixtures/fake-convertx.ts`, an in-process stand-in
implementing the real cookie/redirect/HTML contract including anonymous identity
churn and Secure-cookie behaviour. MCP tools are driven through a real MCP client
over an in-memory transport. No network, no Docker.

A fake is only as good as its fidelity, so the integration suite runs the same
expectations against a real ConvertX container on port 2311:

```bash
docker compose -f docker-compose.test.yml up -d --wait
CONVERTX_IT_BASE_URL=http://127.0.0.1:2311 \
CONVERTX_IT_UNAUTHENTICATED=true npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

**If you change `session.ts` or `parse.ts`, run the integration suite** — the
unit suite alone cannot catch the fake drifting from real ConvertX behaviour.

## Conventions

- Ports: `2300` MCP, `2310` ConvertX, `2311` test ConvertX.
- Never log to stdout — it is the MCP channel under stdio. `no-console` is an
  eslint error; use the stderr helper in `index.ts`.
- Error messages are written for an agent deciding what to do next: state the
  cause and the fix, and name the variable to change.
- Secrets never reach a log or tool error unredacted.

## Landmines already hit

Documented so they are not rediscovered:

- ConvertX marks its session cookie `Secure` unless `HTTP_ALLOWED=true`. Over
  plain HTTP this presents as a login loop that looks like a wrong password.
- ConvertX reads `JWT_SECRET` from the environment only — there is no `_FILE`
  variant. Unset, it regenerates per boot and silently logs this server out after
  a restart.
- The ConvertX image is `debian:testing-slim` and ships `curl`, not `wget`. A
  wget-based healthcheck fails forever and `compose up --wait` reports the
  container unhealthy while it is actually fine.
- `/healthcheck` is declared `auth: false` upstream, so it answers without a
  session. Do not add auth to `convertx_health`.
- Bind-mounted `./data` takes host ownership, overriding the image's. Without
  `chown 1000:1000` conversions succeed and write nothing.
