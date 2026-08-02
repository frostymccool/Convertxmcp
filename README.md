# convertx-mcp-server

An MCP server that fronts a self-hosted [ConvertX](https://github.com/C4illin/ConvertX)
instance, so an AI assistant can convert files between 1000+ formats.

It talks to ConvertX exactly the way a browser does. **ConvertX itself is used
unmodified** — stock image, no patches, no forks, no plugins.

---

# Installation

> **If you are an agent installing this, read this whole Installation section
> before running anything.** The steps are order-dependent. Several of them fail
> in confusing, silent ways if done out of order — a wrong `HTTP_ALLOWED` looks
> exactly like a wrong password, and a missing `JWT_SECRET` works perfectly until
> the first restart. Do not skip the preflight. Do not improvise the account
> setup order. Nothing here should be assumed from memory.

**Target:** a Linux VM with Docker (this was written for a Proxmox VM that also
runs immich). Everything runs in containers; nothing is installed on the host.

**Ports used** — check these are free before starting:

| Port | Bound to | What |
| --- | --- | --- |
| `2300` | `0.0.0.0` | The MCP server. Clients connect here. |
| `2310` | `127.0.0.1` | ConvertX web UI. Localhost-only after setup. |
| `2311` | `127.0.0.1` | Throwaway ConvertX for the test suite. Only while tests run. |

## Step 0 — Preflight

Run all of these first. **Do not continue until every one passes.**

```bash
# 0.1  Docker and the compose plugin are present
docker --version && docker compose version

# 0.2  Ports 2300, 2310 and 2311 are free (expect NO output)
ss -ltnp 2>/dev/null | grep -E ':(2300|2310|2311)\b'

# 0.3  Free disk on the Docker data root (need >= 10 GB free)
docker info --format '{{.DockerRootDir}}' | xargs df -h

# 0.4  The host can reach ghcr.io
curl -sS -o /dev/null -w '%{http_code}\n' https://ghcr.io/v2/
```

**0.2 — if anything is listening**, stop and ask which port to move to rather
than guessing. Changing them means editing `docker-compose.yml` (the left-hand
side of each `ports:` mapping) *and* `MCP_HTTP_PORT`.

**0.3 — disk is the most likely thing to bite on a shared VM.** The ConvertX
image bundles LibreOffice, TeX Live, Calibre, ffmpeg, Inkscape, ImageMagick,
GraphicsMagick, libvips and more:

- **1.55 GB** to download (compressed)
- **~3.6 GB** on disk once unpacked
- plus ~200 MB for this server's own image, plus scratch space for conversions

**10 GB free is the recommended minimum.** If there isn't room, grow the disk
before continuing — a pull that fills the filesystem leaves a half-extracted
image and a Docker daemon in a bad state, which is far more annoying to clean up
than resizing first.

## Step 1 — Get the code

Every command in this guide runs **on the VM**. You do not need an agent, an
editor, or a toolchain installed there — only Docker and this repository, which
is about 1.1 MB against the ~3.6 GB the ConvertX image itself occupies.

```bash
git clone https://github.com/frostymccool/Convertxmcp.git
cd Convertxmcp
```

> **Driving this from another machine over SSH?** That is the expected setup —
> keep your tooling on your workstation and give the VM only this repo. Wrap each
> step as:
>
> ```bash
> ssh you@vm 'cd ~/Convertxmcp && <command>'
> ```
>
> Three things to get right in that mode:
>
> - **Run the preflight remotely too.** `ssh you@vm 'docker info'` — checking your
>   workstation's Docker proves nothing about the VM.
> - **Don't use a remote Docker context** (`docker context create --docker
>   ssh://…`) for this stack. Compose resolves bind mounts like `./data/output`
>   against the *daemon's* filesystem, not yours, so `./data` and
>   `./secrets/convertx_password` must exist on the VM anyway. Cloning the repo
>   there is simpler and has fewer surprises.
> - **Step 3 still needs a browser**, pointed at the VM. Either expose 2310
>   briefly as shown, or tunnel it and keep it closed:
>   `ssh -L 2310:127.0.0.1:2310 you@vm`, then browse `http://127.0.0.1:2310`.
>   The tunnel is the safer option and skips both `sed` port edits in Step 3.

## Step 2 — Create directories and secrets

```bash
mkdir -p secrets data/input data/output

# The ConvertX account password this server will log in with.
# Use -n: a trailing newline is tolerated, but leave it off to avoid confusion
# if you ever paste this value into the web UI by hand.
echo -n 'CHOOSE-A-STRONG-PASSWORD' > secrets/convertx_password
chmod 600 secrets/convertx_password

# .env supplies exactly two values to docker-compose.yml.
cat > .env <<EOF
CONVERTX_EMAIL=mcp@home.lan
CONVERTX_JWT_SECRET=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

> **`CONVERTX_JWT_SECRET` is not optional.** ConvertX reads `JWT_SECRET` from the
> environment only — it has no `_FILE` variant. If it is unset, ConvertX invents
> a new one on every boot, and this server is silently logged out after each
> restart. It will work perfectly until the first `docker compose restart`, then
> fail with what looks like a password problem.

**Set ownership on `./data`, or every conversion fails at the last step:**

```bash
# The MCP container runs unprivileged as uid 1000. A bind mount takes its
# ownership from the host, overriding whatever the image set up, so the
# container cannot write results unless the host directories allow uid 1000.
sudo chown -R 1000:1000 data
```

## Step 3 — Start ConvertX and create its account

ConvertX needs exactly one account, created once through its web UI. Account
registration is disabled by default, so this is a deliberate three-part dance.
**Do these in order.**

```bash
# 3.1  Temporarily allow registration
sed -i 's/ACCOUNT_REGISTRATION: "false"/ACCOUNT_REGISTRATION: "true"/' docker-compose.yml

# 3.2  Start ONLY ConvertX, and temporarily expose it beyond localhost so you
#      can reach the UI from your laptop. (Skip the sed if you are browsing
#      from the VM itself, or are tunnelling with `ssh -L 2310:127.0.0.1:2310`.)
sed -i 's/"127.0.0.1:2310:3000"/"2310:3000"/' docker-compose.yml
docker compose up -d convertx

# 3.3  Wait for it to be ready (first pull is ~1.55 GB, be patient)
until curl -fsS http://127.0.0.1:2310/healthcheck >/dev/null 2>&1; do sleep 3; done
echo "ConvertX is up"
```

Now, **in a browser**, go to `http://<vm-ip>:2310` and register an account using
**exactly** the email from `.env` and the password from
`secrets/convertx_password`. A mismatch here is the single most common cause of
a failed install, and it surfaces later as an authentication error.

Then close it back up:

```bash
# 3.4  Disable registration and re-bind ConvertX to localhost
sed -i 's/ACCOUNT_REGISTRATION: "true"/ACCOUNT_REGISTRATION: "false"/' docker-compose.yml
sed -i 's/"2310:3000"/"127.0.0.1:2310:3000"/' docker-compose.yml
docker compose up -d convertx
```

## Step 4 — Start the MCP server

```bash
docker compose up -d --build
docker compose ps
```

Both containers should show `running`, and `convertx-mcp` should reach
`healthy` within about 30 seconds.

## Step 5 — Verify

Run all four. **The install is not finished until step 5.4 returns converted
bytes** — the first three can pass while the conversion path is still broken.

```bash
# 5.1  The MCP server is alive
curl -fsS http://127.0.0.1:2300/health

# 5.2  It can see ConvertX (expects "reachable": true)
curl -fsS -X POST http://127.0.0.1:2300/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"convertx_health","arguments":{}}}'

# 5.3  The tools are registered (expects three convertx_* tools)
curl -fsS -X POST http://127.0.0.1:2300/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 5.4  END-TO-END: convert a real file. This is the one that matters —
#      it exercises login, upload, convert, poll, download and disk write.
#      PNG -> JPG is used because ImageMagick is always in the ConvertX image;
#      a more exotic pair could fail for lack of a converter rather than a bug.
base64 -d > data/input/smoke.png <<'PNG'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
PNG
curl -fsS -X POST http://127.0.0.1:2300/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"convertx_convert_file","arguments":{
         "source_path":"/data/input/smoke.png","target_format":"jpg"}}}'

# Expect smoke.jpg with a non-zero size.
ls -l data/output/
```

If 5.4 fails, go to [Troubleshooting](#troubleshooting) — do not start
reconfiguring at random.

## Step 6 — Connect a client

```json
{
  "mcpServers": {
    "convertx": { "type": "http", "url": "http://<vm-ip>:2300/mcp" }
  }
}
```

> **This server has no authentication of its own.** Anyone who can reach port
> 2300 can convert files and read anything under `CONVERTX_ALLOWED_INPUT_DIRS`.
> Keep it on the LAN behind your firewall. **Do not port-forward it.**

---

# Operations

```bash
docker compose logs -f convertx-mcp     # server logs
docker compose logs -f convertx         # converter logs (real failure detail)
docker compose restart convertx-mcp     # restart just this server
docker compose pull && docker compose up -d --build   # upgrade both
docker compose down                     # stop (keeps ConvertX data volume)
docker compose down -v                  # stop and DELETE the ConvertX volume,
                                        # which destroys the account from step 3
```

`docker compose down -v` means redoing Step 3 in full. Use plain `down` unless
you specifically intend to wipe it.

---

# Troubleshooting

Work top-down; these are ordered by how often they are the real cause.

| Symptom | Cause and fix |
| --- | --- |
| `rejected the credentials` | The account from Step 3 does not exist, or `.env` / `secrets/convertx_password` disagree with what you typed into the web UI. Re-do Step 3. |
| Worked, then broke after a restart | `CONVERTX_JWT_SECRET` is unset or changed. Set a fixed one in `.env` and `docker compose up -d convertx`. |
| `did not return a session cookie` | ConvertX is missing `HTTP_ALLOWED=true`. On plain HTTP it marks the session cookie `Secure`, so no client can hold a session. The bundled compose file sets it — check it wasn't edited out. |
| Conversion succeeds but nothing in `data/output` | `./data` is not writable by uid 1000. Run `sudo chown -R 1000:1000 data` and restart. |
| `is outside every directory in CONVERTX_ALLOWED_INPUT_DIRS` | Paths are resolved **inside the container**. Use `/data/input/<file>`, not the host path. The file must be under `./data/input` on the host. |
| `redirected to the login page even after re-authenticating` | The instance is running anonymously. Set `CONVERTX_UNAUTHENTICATED=true`, or turn off `ALLOW_UNAUTHENTICATED` on ConvertX. |
| `cannot convert X to Y` | That converter isn't in the image. Call `convertx_list_formats` for the source format to see what is actually offered. |
| `did not allocate a job id` | `CONVERTX_WEBROOT` disagrees with ConvertX's own `WEBROOT`. Leave both unset unless you deliberately mounted it on a subpath. |
| Port already in use on startup | Something else on the VM holds 2300 or 2310. See Step 0.2. |
| Pull fails / disk full | See Step 0.3. Grow the disk, then `docker system prune -f` to clear the partial pull. |

---

# Reference

## Tools

| Tool | Purpose |
| --- | --- |
| `convertx_health` | Is the instance reachable? |
| `convertx_list_formats` | What can this instance convert `<format>` into? |
| `convertx_convert_file` | Convert a file and write the result to disk |

`convertx_list_formats` is authoritative: available conversions depend on which
converters are baked into your ConvertX image, so ask rather than assume.

## Configuration

Full annotated list in [`.env.example`](.env.example). Note that
`docker-compose.yml` sets most values itself and reads only `CONVERTX_EMAIL` and
`CONVERTX_JWT_SECRET` from `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONVERTX_BASE_URL` | *(required)* | Where ConvertX is |
| `CONVERTX_EMAIL` / `CONVERTX_PASSWORD` | — | Account to log in as |
| `CONVERTX_UNAUTHENTICATED` | `false` | Set if ConvertX allows anonymous use |
| `CONVERTX_ALLOWED_INPUT_DIRS` | *(empty)* | Colon-separated dirs readable from disk. Empty disables disk reads entirely |
| `CONVERTX_OUTPUT_DIR` | `/data/output` | Where results are written |
| `CONVERTX_CONVERT_TIMEOUT_MS` | `300000` | Raise for video transcodes |
| `CONVERTX_MAX_FILE_BYTES` | `536870912` | Largest accepted file |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | `2300` | Port for the `http` transport |

Any `CONVERTX_*` secret can be supplied as `<NAME>_FILE` pointing at a file
(Docker secrets, systemd `LoadCredential=`, a bind-mounted file). File-backed
values take precedence over the plain variable. Resolved secrets are registered
with a redactor so they cannot leak through a tool error or log line.

## Running without Docker (stdio)

```json
{
  "mcpServers": {
    "convertx": {
      "command": "node",
      "args": ["/opt/convertx-mcp-server/dist/index.js"],
      "env": {
        "CONVERTX_BASE_URL": "http://192.168.1.50:2310",
        "CONVERTX_EMAIL": "mcp@home.lan",
        "CONVERTX_PASSWORD_FILE": "/run/secrets/convertx_password"
      }
    }
  }
}
```

## Why this is not a thin API wrapper

ConvertX has no REST API. Its pages are server-rendered JSX, authentication is a
JWT cookie, and a conversion is a five-step flow. This server implements that
flow against the same endpoints the web UI uses:

| Step | Endpoint | Notes |
| --- | --- | --- |
| 1. Allocate a job | `GET /` | Job id arrives in the `jobId` cookie |
| 2. Upload | `POST /upload` | multipart, field name `file` |
| 3. Start | `POST /convert` | `convert_to=<target>,<converter>`, `file_names` as JSON |
| 4. Poll | `POST /progress/:jobId` | Returns an HTML fragment, not JSON |
| 5. Download | `GET /download/:userId/:jobId/:name` | |

Two ConvertX behaviours shaped the design, worth knowing if you ever debug this:

- **Completion is signalled by markup, not a status string.** ConvertX renders
  `value` on its `<progress>` element only once every expected file exists. The
  poller keys off that, not off per-file status text.
- **Anonymous mode reassigns identity on every `GET /`.** With
  `ALLOW_UNAUTHENTICATED=true` and `UNAUTHENTICATED_USER_SHARING=false`, each
  visit to `/` mints a *new random user id*. Sharing one cookie jar across jobs
  would leave earlier jobs' output permanently undownloadable, so in anonymous
  mode every job gets its own isolated session.

## Security

- Reads confined to `CONVERTX_ALLOWED_INPUT_DIRS`, checked after resolving
  symlinks and `..`; disabled entirely when the list is empty
- Writes confined to `CONVERTX_OUTPUT_DIR`; output names stripped of any
  directory component
- File sizes capped by `CONVERTX_MAX_FILE_BYTES`
- Container runs as a non-root user
- No authentication on the MCP endpoint itself — LAN use only

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

The unit suite runs against `FakeConvertX`, an in-process stand-in implementing
the real cookie/redirect/HTML contract — including anonymous identity churn,
Secure-cookie behaviour and progress polling. MCP tools are driven through a real
MCP client over an in-memory transport.

Because a fake is only as good as its fidelity, the integration suite runs the
same expectations against a real ConvertX container on port **2311** (chosen so
it does not collide with a running deployment on 2310):

```bash
docker compose -f docker-compose.test.yml up -d --wait
CONVERTX_IT_BASE_URL=http://127.0.0.1:2311 \
CONVERTX_IT_UNAUTHENTICATED=true \
npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

CI runs lint, typecheck, unit tests, the integration suite against a real
ConvertX, and a container image build.

## License

MIT
