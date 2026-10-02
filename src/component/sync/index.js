import { APP_NAME } from '../../constant';

// Keeps the profile on the server the page was loaded from, so every device
// sees the same settings and bookmarks. localStorage stays in place as a
// cache: the app keeps working when the server can not be reached and any
// change made in the meantime is uploaded once the server is back.
//
// Two devices changing things at the same time: the last upload wins.

const DIRTY_KEY = APP_NAME + 'SyncDirty';

const BASE_KEY = APP_NAME + 'SyncRev';

const REV_HEADER = 'X-NightTab-Rev';

const sync = {};

sync.endpoint = { data: 'api/data', events: 'api/events' };

sync.delay = { push: 400, retry: 5000, retryMax: 60000, pull: 4000, busy: 1000 };

// revision on the server as far as this page knows, null while the server has not been reached
sync.rev = null;

// revision announced by the server, differs from sync.rev when another device made a change
sync.remote = null;

// profile known to be on the server
sync.synced = null;

// profile still waiting to be uploaded
sync.pending = null;

sync.inFlight = null;

sync.timer = null;

sync.watching = false;

sync.reloading = false;

// the profile was cleared on this device, the defaults replace the one on the server
sync.cleared = false;

// set when the page is not served by a sync server, e.g. the browser extension
sync.disabled = false;

// same keys in the same order, so equal profiles are equal strings on every device
sync.sorted = (value) => {
  if (Array.isArray(value)) { return value.map(sync.sorted); }

  if (value !== null && typeof value === 'object') {
    const object = {};

    Object.keys(value).sort().forEach((key) => { object[key] = sync.sorted(value[key]); });

    return object;
  }

  return value;
};

// what goes to the server: without the state which only makes sense on the device it was set on
sync.normalise = (text) => {
  try {
    const profile = JSON.parse(text);

    profile.state.menu = false;
    profile.state.modal = false;
    profile.state.search = false;
    profile.state.bookmark.edit = false;
    profile.state.bookmark.add = false;
    profile.state.group.edit = false;
    profile.state.group.add = false;
    profile.state.theme.custom.edit = false;

    // follows the window width, every device works it out again on load
    profile.state.layout.breakpoint = 'xs';

    // empty leftover which only exists after certain controls were used
    if (profile.state.bookmark.item && Object.keys(profile.state.bookmark.item).length === 0) {
      delete profile.state.bookmark.item;
    }

    return JSON.stringify(sync.sorted(profile));
  } catch {
    return text;
  }
};

// marks local data which has not reached the server yet, survives a reload
sync.dirty = {
  set: () => { window.localStorage.setItem(DIRTY_KEY, '1'); },
  clear: () => { window.localStorage.removeItem(DIRTY_KEY); },
  get: () => window.localStorage.getItem(DIRTY_KEY) !== null
};

// revision the local data was last in step with, null when this device never synced
sync.base = {
  set: (rev) => { window.localStorage.setItem(BASE_KEY, rev); },
  get: () => window.localStorage.getItem(BASE_KEY)
};

sync.connected = (rev) => {
  sync.rev = rev;

  sync.base.set(rev);
};

// Unsent local changes go to the server, except from a device which never
// synced: it only has defaults and must not replace an existing profile.
sync.localWins = (serverRev) => sync.base.get() !== null || serverRev === '';

sync.reload = () => {
  if (sync.reloading) { return; }

  sync.reloading = true;

  window.location.reload();
};

sync.send = async (body, keepalive = false) => {
  const response = await window.fetch(sync.endpoint.data, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body,
    keepalive: keepalive
  });

  if (!response.ok) { throw new Error('status ' + response.status); }

  return (await response.json()).rev;
};

// send what is in localStorage
sync.upload = async () => {
  const local = window.localStorage.getItem(APP_NAME);

  if (local === null) {
    // cleared, the app saves its defaults once it has started
    sync.cleared = true;

    return;
  }

  sync.pending = local;

  await sync.flush();
};

// get the profile from the server before the app reads localStorage
sync.pull = async () => {
  let response;

  try {
    response = await window.fetch(sync.endpoint.data, { cache: 'no-store', signal: AbortSignal.timeout(sync.delay.pull) });
  } catch (error) {
    console.warn('sync: server not reachable, using local data', error);

    sync.recoverTimer = setTimeout(sync.recover, sync.delay.retry);

    return;
  }

  if (!response.ok) {
    console.warn('sync: no sync server here, data stays on this device');

    sync.disabled = true;

    return;
  }

  const serverRev = response.status === 200 ? response.headers.get(REV_HEADER) : '';

  if (sync.dirty.get()) {
    if (sync.localWins(serverRev)) {
      console.log('sync: uploading changes the server has not seen yet');

      sync.connected(serverRev);

      await sync.upload();

      return;
    }

    sync.dirty.clear();
  }

  if (response.status === 200) {
    const remote = await response.text();

    window.localStorage.setItem(APP_NAME, remote);

    sync.synced = sync.normalise(remote);

    sync.connected(serverRev);

    console.log('sync: profile loaded from server');
  } else {
    // A server without a profile is a new one: clearing the data on a device
    // uploads the defaults, it never empties the server.
    console.log('sync: server has no profile yet');

    sync.connected(serverRev);

    await sync.upload();

    sync.cleared = false;
  }
};

// the page started without the server, keep trying to get back in step
sync.recover = async (delay = sync.delay.retry) => {
  clearTimeout(sync.recoverTimer);

  let serverRev;

  try {
    const response = await window.fetch(sync.endpoint.data, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(sync.delay.pull) });

    if (!response.ok) { throw new Error('status ' + response.status); }

    serverRev = response.status === 200 ? response.headers.get(REV_HEADER) : '';
  } catch {
    sync.recoverTimer = setTimeout(() => { sync.recover(Math.min(delay * 2, sync.delay.retryMax)); }, delay);

    return;
  }

  if (sync.dirty.get() && sync.localWins(serverRev)) {
    sync.connected(serverRev);

    sync.watch();

    await sync.upload();
  } else if (sync.dirty.get() || serverRev !== sync.base.get()) {
    // the server profile is the one to show, the reload pulls it
    sync.dirty.clear();

    sync.pending = null;

    sync.reload();
  } else {
    sync.connected(serverRev);

    sync.watch();
  }
};

sync.push = (value) => {
  if (sync.disabled) { return; }

  sync.pending = value;

  sync.dirty.set();

  clearTimeout(sync.timer);

  sync.timer = setTimeout(sync.flush, sync.delay.push);
};

// "clear all data": nothing to send now, the page reloads and uploads the defaults it starts with
sync.remove = () => {
  if (sync.disabled) { return; }

  clearTimeout(sync.timer);

  sync.pending = null;

  sync.dirty.set();
};

sync.flush = async ({ keepalive = false } = {}) => {
  clearTimeout(sync.timer);

  if (sync.inFlight) { await sync.inFlight; }

  // without knowing the server state nothing is sent, sync.recover takes over
  if (sync.pending === null || sync.rev === null) { return; }

  const pending = sync.pending;

  const body = sync.normalise(pending);

  const settled = () => {
    if (sync.pending === pending) {
      sync.pending = null;

      sync.dirty.clear();
    }
  };

  if (body === sync.synced) {
    settled();

    sync.refresh();

    return;
  }

  sync.inFlight = sync.send(body, keepalive).then((rev) => {
    sync.synced = body;

    sync.connected(rev);

    settled();

    return true;
  }).catch((error) => {
    console.warn('sync: upload failed, will retry', error);

    sync.timer = setTimeout(sync.flush, sync.delay.retry);

    return false;
  }).finally(() => { sync.inFlight = null; });

  const sent = await sync.inFlight;

  // something changed while the request was on its way
  if (sent && sync.pending !== null) {
    await sync.flush();
  } else {
    sync.refresh();
  }
};

sync.busy = () => {
  return document.querySelector('html').classList.contains('is-menu-open') ||
    document.querySelector('.modal') !== null ||
    document.querySelector('.sortable-chosen, .sortable-ghost') !== null;
};

// another device changed the profile, show it once nothing is in the way
sync.refresh = () => {
  clearTimeout(sync.refreshTimer);

  if (sync.remote === null || sync.remote === sync.rev) { return; }

  // a local change is on its way and will be the latest
  if (sync.pending !== null || sync.inFlight) { return; }

  if (sync.busy()) {
    sync.refreshTimer = setTimeout(sync.refresh, sync.delay.busy);

    return;
  }

  sync.reload();
};

sync.watch = () => {
  if (sync.watching || sync.rev === null || !window.EventSource) { return; }

  sync.watching = true;

  const events = new window.EventSource(sync.endpoint.events);

  events.addEventListener('rev', (event) => {
    sync.remote = event.data;

    sync.refresh();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // last chance to get a change out before the tab goes away
      sync.flush({ keepalive: true });
    } else {
      sync.flush().then(sync.refresh);
    }
  });
};

export { sync };
