# nightTab, self-hosted

**[nightTab](https://github.com/zombieFox/nightTab) as a self-hosted start page: one profile, stored on your server, the same on every device.**

nightTab keeps its settings and bookmarks in the browser's `localStorage`, so every browser has its own start page and you carry JSON exports from one to the other. This fork adds a small server and a Docker image. The page looks and works exactly like nightTab, but your layout, groups, bookmarks and themes live on the server and follow you to every device that opens it.

[![nightTab](asset/screenshot/screenshot-001.png)](https://github.com/zombieFox/nightTab)

All credit for nightTab itself goes to [zombieFox](https://github.com/zombieFox). This fork changes how the data is stored and nothing else.

## What you get

- **One shared profile** – settings, groups, bookmarks and custom themes are stored as a JSON file on the server.
- **Live on all devices** – change something on your laptop and the open tab on your desktop updates itself a moment later.
- **Works when the server is away** – the browser keeps a cached copy; changes made in the meantime are uploaded when the server is back.
- **Backups included** – the server keeps the last 30 versions of the profile.
- **One small container** – Node standard library only, no database, no runtime dependencies.

## What it is not

- **No login.** Everyone who can reach the page can read and change the profile. Put it behind your LAN, VPN or a reverse proxy with access control. Do not expose it to the internet as it is.
- **No accounts.** One server holds one profile. Run a second container for a second profile.
- **No merging.** When two devices change something at the same moment, the last upload wins. The overwritten version is in the backups.

## Quick start

With the prebuilt image (amd64 and arm64), save this as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  nighttab:
    image: ghcr.io/alfajackal/nighttab-selfhosted:latest
    container_name: nighttab
    restart: unless-stopped
    ports:
      - "8585:8080"
    volumes:
      - nighttab-data:/data

volumes:
  nighttab-data:
```

Open `http://<your-host>:8585`. The first device that opens the page creates the profile.

To update, run `docker compose pull` followed by `docker compose up -d`.

### Building it yourself

```bash
git clone https://github.com/AlfaJackal/nightTab-selfhosted.git
cd nightTab-selfhosted
docker compose up -d --build
```

This uses the `docker-compose.yml` from the repository, which keeps the profile in the `data/` folder next to it. To update, run `git pull` followed by `docker compose up -d --build`.

### Bringing your existing nightTab setup

In your current nightTab open the menu → *Data* → *Backup* and export the file. On the new page open the menu → *Data* → *Restore* and import it. From that moment it is the shared profile.

### Using it as your new tab page

The page is a normal website, so set it as your browser's home page, or use any "custom new tab URL" extension to point new tabs at it.

## Configuration

The `docker-compose.yml` from the repository reads these from a `.env` file next to it:

| Variable | Default | Meaning |
|---|---|---|
| `NIGHTTAB_PORT` | `8585` | port on the host |
| `PUID` / `PGID` | `1000` | user the container runs as, it has to be able to write `./data` |

The container itself also reads `BACKUP_KEEP` (number of backups to keep, default `30`) and `MAX_BODY_MB` (largest accepted profile, default `10`).

## Your data

```
/data/nighttab.json      the profile
/data/backups/           the previous versions, one for every change
```

`nighttab.json` has the same format as a nightTab export, so it can be imported into any nightTab. To go back to an older version, copy a file from `backups/` over `nighttab.json` and restart the container. `/data` in the container is the `nighttab-data` volume, or the `data/` folder if you built from the repository. It is all you need to back up.

## Reverse proxy

Any reverse proxy works. The page keeps one long-lived request open (`/api/events`, Server-Sent Events), which must not be buffered. Caddy needs nothing special:

```caddyfile
start.example.com {
	@lan remote_ip 192.168.0.0/16 10.0.0.0/8
	handle @lan {
		reverse_proxy 127.0.0.1:8585
	}
	respond 403
}
```

The server sends `X-Accel-Buffering: no` for the event stream, which nginx honours.

## How the sync works

- **Start:** the page fetches the profile from the server and puts it into `localStorage` before nightTab starts. `localStorage` is only a cache now.
- **Change:** every save is sent to the server 0.4 seconds later.
- **Other devices:** open pages listen on an event stream and reload when the profile changed. A page with an open menu or dialog waits until it is closed.
- **Server not reachable:** the page starts from its cache after 4 seconds and keeps the changes until the server answers again. A device that has never synced does not overwrite an existing profile with its defaults.
- **Not synced:** state that belongs to one device – edit mode, the open menu, the search field and the layout breakpoint that follows the window width.
- **"Clear all data"** in the menu resets the profile for all devices. The version before that is in the backups.
- **Empty server** (new deployment, lost volume): the first device that opens the page uploads its cached copy, so the profile comes back by itself.

### API

| | |
|---|---|
| `GET /api/data` | the profile, its revision in the `X-NightTab-Rev` header; `204` when there is none yet |
| `PUT /api/data` | replace the profile, answers `{"rev": "…"}` |
| `DELETE /api/data` | remove the profile; the app never calls this |
| `GET /api/events` | event stream, sends a `rev` event for every change |
| `GET /api/health` | `{"ok": true, "rev": "…"}` |

## Development

```bash
npm install
npm run build              # web app into dist/web
DATA_DIR=./data node server/index.js
```

`npm start` still runs the webpack dev server from upstream; without the sync server behind it the page falls back to plain `localStorage`.

```bash
sh test/run.sh
```

runs the end-to-end test: a throwaway server and a headless Chrome in their own Docker network, two simulated devices and 24 checks (first profile, change from A to B, open menu, server away, clear all, new device).

## Changes to upstream

This is a fork of nightTab 7.6.0 and keeps its GPL-3 licence. Changed or added:

| File | Change |
|---|---|
| `server/index.js` | new – serves the built app and stores the profile |
| `src/component/sync/index.js` | new – pull before start, upload on save, reload on remote change |
| `src/component/data/index.js` | `data.set`, `data.remove` and `data.reload.render` call the sync |
| `src/index.js` | waits for the profile before starting the app |
| `Dockerfile`, `docker-compose.yml`, `test/` | new |

Everything else is untouched, so upstream changes merge cleanly:

```bash
git remote add upstream https://github.com/zombieFox/nightTab.git
git pull upstream main
```

For everything about nightTab itself – features, themes, keyboard shortcuts – see the [upstream wiki](https://github.com/zombieFox/nightTab/wiki).

## Earlier work

Server-side storage for nightTab has been asked for since 2020 ([#93](https://github.com/zombieFox/nightTab/issues/93), [#189](https://github.com/zombieFox/nightTab/issues/189), [#212](https://github.com/zombieFox/nightTab/issues/212)). [deanbarrow](https://github.com/deanbarrow) built the first working answer in [#227](https://github.com/zombieFox/nightTab/pull/227) with a separate [sync server](https://github.com/deanbarrow/nightTab-sync-server); it targets the old gulp-based nightTab 5/6 and is no longer maintained. This fork starts over on the current webpack-based nightTab 7 and puts page and storage into one container, with live updates between devices and backups.

## Licence

[GPL-3](license), like nightTab.
