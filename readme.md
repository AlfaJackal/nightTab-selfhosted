# nightTab, self-hosted

**[nightTab](https://github.com/zombieFox/nightTab) as a self-hosted start page: one profile, stored on your server, the same on every device.**

nightTab keeps its settings and bookmarks in the browser's `localStorage`. Every browser therefore has its own start page, and moving a setup from one device to another means exporting and importing a JSON file by hand.

This fork adds a small server and a Docker image. The page looks and works exactly like nightTab, but your layout, groups, bookmarks and themes are stored on the server. Open the page on any device and you see the same start page; change it anywhere and it changes everywhere.

[![nightTab with a custom layout and theme](asset/screenshot/screenshot-011.png)](#example-setups)

All credit for nightTab itself goes to [zombieFox](https://github.com/zombieFox). This fork changes where the data is stored and nothing else.

## Contents

- [What you get](#what-you-get)
- [What it is not](#what-it-is-not)
- [Install](#install)
- [First steps](#first-steps)
- [Example setups](#example-setups)
- [Configuration](#configuration)
- [Your data and backups](#your-data-and-backups)
- [Reverse proxy and access control](#reverse-proxy-and-access-control)
- [How the sync behaves](#how-the-sync-behaves)
- [Troubleshooting](#troubleshooting)
- [API](#api)
- [Development](#development)
- [Changes to upstream](#changes-to-upstream)
- [Earlier work](#earlier-work)

## What you get

- **One shared profile.** Settings, groups, bookmarks and custom themes are stored as one JSON file on the server.
- **Automatic sync.** Every change is saved to the server by itself. There is no sync button.
- **Live on all devices.** Change something on your laptop and the open tab on your desktop updates itself a moment later.
- **Survives a server hiccup.** An open page keeps working while the server is away; changes made in the meantime are uploaded when it is back.
- **Backups included.** The server keeps the last 30 versions of the profile.
- **One small container.** It serves the page and stores the data. No database, no runtime dependencies beyond Node.

## What it is not

Read this before you install it.

- **There is no login.** Everyone who can reach the page can read and change the profile. Keep it inside your LAN or VPN, or put a reverse proxy with access control in front of it. Do not expose it to the internet as it is.
- **There are no accounts.** One container holds one profile. For a second profile, run a second container.
- **Changes are not merged.** If two devices change something at the same moment, the last one wins. The version that lost is in the backups.

## Install

You need Docker with the compose plugin. Save this as `docker-compose.yml`:

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

Start it:

```bash
docker compose up -d
```

Open `http://<your-host>:8585`. The first device that opens the page creates the profile, starting with nightTab's example bookmarks.

The image is built for `amd64` and `arm64` (for example a Raspberry Pi with a 64-bit system). So far it has been run on `amd64` only.

**Pin a version.** `latest` follows every change in this repository. For a fixed version, replace `latest` with a release tag such as `7.6.0-selfhosted.1`; the [releases page](https://github.com/AlfaJackal/nightTab-selfhosted/releases) lists them.

**Update:**

```bash
docker compose pull
docker compose up -d
```

### Building the image yourself

```bash
git clone https://github.com/AlfaJackal/nightTab-selfhosted.git
cd nightTab-selfhosted
docker compose up -d --build
```

The `docker-compose.yml` in the repository builds the image locally and keeps the profile in the `data/` folder next to it instead of a Docker volume. To update, run `git pull` followed by `docker compose up -d --build`.

## First steps

### Bring your existing nightTab setup

1. In the nightTab you use today, open the menu (gear icon) → **Data** → **Backup** and export the file.
2. On your new page, open the menu → **Data** → **Restore** and import that file.

From that moment it is the shared profile on the server.

### Use it as your home page or new tab page

The page is a normal website. Set its address as your browser's home page. For new tabs, browsers need an extension that opens a custom URL in new tabs; any of them works.

The nightTab browser extension itself is not part of this fork. It runs inside the browser without a server and cannot sync.

### Add more devices

Just open the same address. There is nothing to set up per device.

## Example setups

nightTab can look very different from its defaults. These setups come from zombieFox and ship with this repository; click a picture to get its file.

| | |
|---|---|
| [![Example setup 3](asset/screenshot/screenshot-003.png)](asset/screenshot/screenshot-003.json) | [![Example setup 4](asset/screenshot/screenshot-004.png)](asset/screenshot/screenshot-004.json) |
| [![Example setup 5](asset/screenshot/screenshot-005.png)](asset/screenshot/screenshot-005.json) | [![Example setup 6](asset/screenshot/screenshot-006.png)](asset/screenshot/screenshot-006.json) |
| [![Example setup 7](asset/screenshot/screenshot-007.png)](asset/screenshot/screenshot-007.json) | [![Example setup 8](asset/screenshot/screenshot-008.png)](asset/screenshot/screenshot-008.json) |
| [![Example setup 9](asset/screenshot/screenshot-009.gif)](asset/screenshot/screenshot-009.json) | [![Example setup 10](asset/screenshot/screenshot-010.png)](asset/screenshot/screenshot-010.json) |
| [![Example setup 11](asset/screenshot/screenshot-011.png)](asset/screenshot/screenshot-011.json) | |

**Try one:** download the `.json` file from [asset/screenshot](asset/screenshot), then open the menu → **Data** → **Restore** and import it. The import dialog offers three boxes – *Settings*, *Theme* and *Bookmarks*. Untick *Bookmarks* to get only the look and keep your own.

Because the profile is shared, the new look appears on all your devices. The version you had before is in the [backups](#your-data-and-backups).

## Configuration

**Port.** The page listens on port `8080` inside the container. Change the left number in `"8585:8080"` to use another port on your host.

**Environment variables** of the container, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_KEEP` | `30` | how many previous versions of the profile to keep |
| `MAX_BODY_MB` | `10` | largest profile the server accepts, in megabytes |
| `PORT` | `8080` | port inside the container |
| `DATA_DIR` | `/data` | where the profile is stored inside the container |

Set them under `environment:` in your compose file, for example:

```yaml
    environment:
      - BACKUP_KEEP=100
```

**A folder instead of a volume.** If you would rather see the files on your host, replace `nighttab-data:/data` with `./data:/data`. The container runs as user id `1000`, which has to be able to write that folder:

```bash
mkdir data && sudo chown 1000:1000 data
```

To run as a different user, add `user: "<uid>:<gid>"` to the service and make the folder writable for that user.

**The compose file in the repository** (for building it yourself) reads two settings from a `.env` file next to it: `NIGHTTAB_PORT` (default `8585`) and `PUID` / `PGID` (default `1000`).

**A second profile.** Copy the service under another name with another port and another volume. Each container is one independent start page.

## Your data and backups

Everything lives in `/data` inside the container:

```
/data/nighttab.json     the profile
/data/backups/          the previous versions, one for every change
```

`nighttab.json` has the same format as an export from the nightTab menu, so you can also import it into any other nightTab.

**Copy the data out** (for your own backup):

```bash
docker cp nighttab:/data ./nighttab-backup
```

**Go back to an older version:**

```bash
docker exec nighttab ls /data/backups
docker exec nighttab cp /data/backups/<file> /data/nighttab.json
docker restart nighttab
```

Open pages pick up the restored version by themselves.

The file names in `backups/` start with the time the version was replaced, so the newest file is the version just before your last change.

## Reverse proxy and access control

Any reverse proxy works. Use it to add HTTPS and to decide who may reach the page, since the page itself lets everyone in.

**Caddy**, reachable only from private networks:

```caddyfile
start.example.com {
	@allowed remote_ip 192.168.0.0/16 10.0.0.0/8
	handle @allowed {
		reverse_proxy 127.0.0.1:8585
	}
	respond 403
}
```

**nginx:**

```nginx
location / {
    proxy_pass http://127.0.0.1:8585;
    proxy_set_header Host $host;
}
```

One thing matters for every proxy: the page keeps one request open permanently (`/api/events`) to hear about changes from other devices. The proxy must pass it through without buffering. Caddy does this by itself, and so does nginx, because the server asks for it with the `X-Accel-Buffering: no` header. The server sends a keep-alive line every 25 seconds, so the usual 60-second proxy timeouts are fine.

## How the sync behaves

- **Opening the page.** The page fetches the profile from the server first and only then starts nightTab. The browser's `localStorage` is now just a cache.
- **Changing something.** Every save is sent to the server about half a second later.
- **Other devices.** Open pages are told about the change and reload by themselves. A page with an open menu or dialog waits until you close it, so nothing is torn away while you edit.
- **Two devices at the same moment.** The last upload wins and replaces the whole profile. The other version is in the backups.
- **Server goes away while a page is open.** The page keeps working. Changes are remembered and uploaded as soon as the server answers again.
- **Server is down when you open the page.** The page cannot load, because the server delivers it. If only the storage part does not answer within 4 seconds, the page starts from its cache.
- **A brand-new device** never overwrites an existing profile with its defaults.
- **Kept per device, not synced:** edit mode, the open menu, the search field and the layout breakpoint that follows the window width.
- **"Clear all data"** in the menu resets the profile for all devices. The version before that is in the backups.
- **Empty server** (new installation, lost volume): the first device that still has a cached copy uploads it, so the profile comes back by itself.

## Troubleshooting

**A change does not show up on another device until I reload.** The event stream does not get through. Open `http://<your-address>/api/events` in a browser: a line starting with `data:` has to appear at once. If the page stays empty, your reverse proxy buffers the response.

**Nothing is saved, the container log shows `EACCES` or "permission denied".** The container cannot write `/data`. This happens with a folder mount that belongs to another user, see [Configuration](#configuration).

**The page shows the example bookmarks instead of my setup.** The server has no profile yet, or the one it has is the default. Import your export as described in [First steps](#first-steps), or restore a backup.

**Is it running?** `http://<your-address>/api/health` answers `{"ok":true,…}`, and `docker ps` shows the container as `healthy`.

**What is the server doing?** `docker logs nighttab` lists every saved version with its time and size.

## API

The page uses these itself; they are handy for scripts and monitoring too.

| | |
|---|---|
| `GET /api/data` | the profile, its revision in the `X-NightTab-Rev` header; `204` when there is none yet |
| `PUT /api/data` | replace the profile, answers `{"rev": "…"}` |
| `DELETE /api/data` | remove the profile; the page never calls this |
| `GET /api/events` | event stream, sends a `rev` event for every change |
| `GET /api/health` | `{"ok": true, "rev": "…"}` |

## Development

```bash
npm install
npm run build                           # builds the page into dist/web
DATA_DIR=./data node server/index.js    # http://localhost:8080
```

`npm start` still runs the webpack dev server from upstream. Without the sync server behind it, the page falls back to plain `localStorage`.

**Test:**

```bash
sh test/run.sh
```

This starts a throwaway server and a headless Chrome in their own Docker network and plays through the sync with simulated devices: first profile, change from one device to the other, open menu, server away, clear all, new device. 24 checks, and your real profile is not touched.

## Changes to upstream

This is a fork of nightTab 7.6.0 and keeps its GPL-3 licence. Changed or added:

| File | Change |
|---|---|
| `server/index.js` | new – serves the built page and stores the profile |
| `src/component/sync/index.js` | new – fetch before start, upload on save, reload on a change from elsewhere |
| `src/component/data/index.js` | `data.set`, `data.remove` and `data.reload.render` call the sync |
| `src/index.js` | waits for the profile before starting the page |
| `Dockerfile`, `docker-compose.yml`, `test/`, `.github/workflows/docker-publish.yml` | new |

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
