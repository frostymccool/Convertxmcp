# convertx-mcp-server

An MCP server that fronts a self-hosted [ConvertX](https://github.com/C4illin/ConvertX)
instance, so an AI assistant can convert files between 1000+ formats.

It talks to ConvertX exactly the way a browser does. **ConvertX itself is used
unmodified** — stock image, no patches, no forks, no plugins.

## Why this is not a thin API wrapper

ConvertX has no REST API. Its pages are server-rendered JSX, authentication is a
JWT cookie, and a conversion is a five-step flow across five endpoints. This
server implements that flow against the same endpoints the web UI uses:

| Step | Endpoint | Notes |
| --- | --- | --- |
| 1. Allocate a job | `GET /` | Job id arrives in the `jobId` cookie |
| 2. Upload | `POST /upload` | multipart, field name `file` |
| 3. Start | `POST /convert` | `convert_to=<target>,<converter>`, `file_names` as JSON |
| 4. Poll | `POST /progress/:jobId` | Returns an HTML fragment, not JSON |
| 5. Download | `GET /download/:userId/:jobId/:name` | |

Two behaviours of ConvertX shaped the design, and are worth knowing if you ever
debug this:

- **Completion is signalled by markup, not a status string.** ConvertX renders
  `value` on its `<progress>` element only once every expected file exists. The
  poller keys off that, not off per-file status text.
- **Anonymous mode reassigns your identity on every `GET /`.** With
  `ALLOW_UNAUTHENTICATED=true` and `UNAUTHENTICATED_USER_SHARING=false`, each
  visit to `/` mints a *new random user id*. Sharing one cookie jar across jobs
  would leave earlier jobs' output permanently undownloadable, so in anonymous
  mode every job gets its own isolated session.

## Tools

| Tool | Purpose |
| --- | --- |
| `convertx_health` | Is the instance reachable? |
| `convertx_list_formats` | What can this instance convert `<format>` into? |
| `convertx_convert_file` | Convert a file and write the result to disk |

`convertx_list_formats` is authoritative: the available conversions depend on
which converters are baked into your ConvertX image, so ask rather than assume.

## Quick start (Proxmox VM, Docker)

```bash
git clone https://github.com/frostymccool/Convertxmcp.git && cd Convertxmcp

mkdir -p secrets data/input data/output
echo -n 'a-strong-password'      > secrets/convertx_password
printf 'CONVERTX_EMAIL=mcp@home.lan\nCONVERTX_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > .env

docker compose up -d
```

Then create the ConvertX account once:

1. Set `ACCOUNT_REGISTRATION: "true"` for the `convertx` service and
   `docker compose up -d convertx`.
2. Visit `http://<vm-ip>:3000`, register using the same email and password you
   put in `.env` / `secrets/convertx_password`.
3. Set `ACCOUNT_REGISTRATION` back to `"false"` and `docker compose up -d convertx`.

The MCP server is then at `http://<vm-ip>:8080/mcp`.

> **`HTTP_ALLOWED=true` is not optional on a plain-HTTP LAN.** Without it
> ConvertX marks its session cookie `Secure`, no HTTP client can hold a session,
> and every call fails as if the password were wrong. The compose file sets it.

## Configuration

Every setting is an environment variable; see [`.env.example`](.env.example) for
the annotated list. The essentials:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONVERTX_BASE_URL` | *(required)* | Where ConvertX is |
| `CONVERTX_EMAIL` / `CONVERTX_PASSWORD` | — | Account to log in as |
| `CONVERTX_UNAUTHENTICATED` | `false` | Set if ConvertX allows anonymous use |
| `CONVERTX_ALLOWED_INPUT_DIRS` | *(empty)* | Colon-separated dirs readable from disk |
| `CONVERTX_OUTPUT_DIR` | `/data/output` | Where results are written |
| `CONVERTX_CONVERT_TIMEOUT_MS` | `300000` | Raise for video transcodes |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |

### Secrets

No secret has to be an environment variable. Any `CONVERTX_*` value can instead
be supplied as `<NAME>_FILE` pointing at a file — Docker secrets, systemd
`LoadCredential=`, or a bind-mounted file on the VM:

```yaml
environment:
  CONVERTX_PASSWORD_FILE: /run/secrets/convertx_password
```

File-backed values win over the plain variable. Resolved secrets are registered
with a redactor, so they cannot be echoed back through a tool error or a log line.

## Connecting a client

**Over HTTP** (the service on your VM):

```json
{
  "mcpServers": {
    "convertx": { "type": "http", "url": "http://192.168.1.50:8080/mcp" }
  }
}
```

**Over stdio** (client spawns it locally):

```json
{
  "mcpServers": {
    "convertx": {
      "command": "node",
      "args": ["/opt/convertx-mcp-server/dist/index.js"],
      "env": {
        "CONVERTX_BASE_URL": "http://192.168.1.50:3000",
        "CONVERTX_EMAIL": "mcp@home.lan",
        "CONVERTX_PASSWORD_FILE": "/run/secrets/convertx_password"
      }
    }
  }
}
```

## Security

This server has **no authentication of its own**. It is designed for a trusted
LAN, which is why `MCP_HTTP_HOST` defaults to `127.0.0.1`; binding `0.0.0.0`
exposes it to everyone who can reach the VM. Put it behind your firewall, and do
not port-forward it.

Within that trust boundary it is still defensive:

- Reads are confined to `CONVERTX_ALLOWED_INPUT_DIRS`, checked after resolving
  symlinks and `..`, and disabled entirely when that list is empty.
- Writes are confined to `CONVERTX_OUTPUT_DIR`; output names are stripped of any
  directory component.
- File sizes are capped by `CONVERTX_MAX_FILE_BYTES`.
- The container runs as a non-root user.

## Development

```bash
npm install
npm run verify   # format check, lint, typecheck, unit tests with coverage
```

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (fast, hermetic, no network) |
| `npm run test:coverage` | Unit tests with coverage thresholds |
| `npm run test:integration` | Against a real ConvertX (see below) |
| `npm run build` | Compile to `dist/` |
| `npm run dev` | Watch mode |

### Testing approach

The unit suite runs against `FakeConvertX`, an in-process stand-in that
implements the real cookie/redirect/HTML contract — including anonymous identity
churn, Secure-cookie behaviour, and progress polling. That keeps `npm test`
hermetic while still covering the full conversion workflow, and the MCP tools are
driven through a real MCP client over an in-memory transport.

Because a fake is only as good as its fidelity, the integration suite runs the
same expectations against a real ConvertX container:

```bash
docker compose -f docker-compose.test.yml up -d --wait
CONVERTX_IT_BASE_URL=http://127.0.0.1:3000 \
CONVERTX_IT_UNAUTHENTICATED=true \
npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

CI runs lint, typecheck, unit tests, the integration suite against a real
ConvertX, and a container image build.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "did not return a session cookie" | ConvertX is missing `HTTP_ALLOWED=true` on plain HTTP |
| "rejected the credentials" | Account does not exist yet — register it in the web UI |
| "redirected to the login page even after re-authenticating" | Instance is anonymous; set `CONVERTX_UNAUTHENTICATED=true` |
| "did not allocate a job id" | `CONVERTX_WEBROOT` disagrees with ConvertX's `WEBROOT` |
| Sessions drop after every ConvertX restart | `JWT_SECRET` unset, so ConvertX regenerates it each boot |
| "cannot convert X to Y" | Your image lacks that converter — check `convertx_list_formats` |

## License

MIT
