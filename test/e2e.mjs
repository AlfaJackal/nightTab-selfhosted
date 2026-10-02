// End to end test of the sync: two browser profiles ("devices") against one server.
// Needs Node 22+, a running server and a Chrome with remote debugging, see test/run.sh.

import { lookup } from 'node:dns/promises';

const APP = process.env.APP || 'http://127.0.0.1:8585/';
const CHROME = process.env.CHROME || '127.0.0.1:9222';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome only answers the debugging port when it is addressed by IP
const [chromeHost, chromePort] = CHROME.split(':');
const chrome = `${(await lookup(chromeHost)).address}:${chromePort}`;

const version = await (await fetch(`http://${chrome}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl.replace(/\/\/[^/]+/, '//' + chrome));

await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

let lastId = 0;
const waiting = new Map();

socket.onmessage = (message) => {
  const data = JSON.parse(message.data);

  if (!data.id || !waiting.has(data.id)) { return; }

  const { resolve, reject } = waiting.get(data.id);

  waiting.delete(data.id);

  if (data.error) { reject(new Error(JSON.stringify(data.error))); } else { resolve(data.result); }
};

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++lastId;

  waiting.set(id, { resolve, reject });

  socket.send(JSON.stringify({ id, method, params, sessionId }));
});

// helpers living in the page
const PAGE = `
  window.t = {
    button: (pattern, scope) => {
      const all = [...(scope ? document.querySelector(scope) : document).querySelectorAll('button')];
      const found = all.filter((b) => pattern.test((b.textContent || '').trim()) || pattern.test(b.title || ''));
      if (found.length === 0) { throw new Error('no button ' + pattern + ' in ' + all.map((b) => (b.textContent || '').trim()).join(' | ')); }
      found[found.length - 1].click();
    },
    accent: (hex) => {
      const input = document.querySelector('input[type=color]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, hex);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    profile: () => JSON.parse(localStorage.getItem('nightTab')),
    groups: () => [...document.querySelectorAll('.group-name-text')].map((e) => e.textContent)
  };
`;

const device = async (name, width, height) => {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE }, sessionId);

  const run = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);

    if (result.exceptionDetails) { throw new Error(name + ': ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text)); }

    return result.result.value;
  };

  return {
    name,
    run,
    open: async () => { await send('Page.navigate', { url: APP }, sessionId); await sleep(2500); },
    offline: (offline) => send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId),
    // a page reload throws the marker away
    mark: () => run('window.__mark = true'),
    marked: () => run('window.__mark === true'),
    // number of tabs this device has open
    tabs: async () => (await send('Target.getTargets')).targetInfos.filter((target) => target.type === 'page' && target.browserContextId === browserContextId).length
  };
};

const server = async () => {
  const response = await fetch(APP + 'api/data');

  return { rev: response.headers.get('X-NightTab-Rev') || '', profile: response.status === 200 ? await response.json() : null };
};

let failed = 0;

const check = (label, ok, detail = '') => {
  if (!ok) { failed++; }

  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ' ' + JSON.stringify(detail)}`);
};

const hex = (profile) => {
  const { r, g, b } = profile.state.theme.accent.rgb;

  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------- scenario

check('server starts empty', (await server()).profile === null);

const a = await device('A', 1280, 800);
const b = await device('B', 390, 800);

await a.open();

let state = await server();

check('first device creates the profile', state.profile !== null && state.profile.nightTab === true);

const defaultAccent = hex(state.profile);
const defaultGroups = await a.run('t.groups()');
const firstRev = state.rev;

await b.open();
await sleep(2000);

state = await server();

check('second device with another window size leaves the profile alone', state.rev === firstRev, { firstRev, now: state.rev });
check('second device shows the same groups', JSON.stringify(await b.run('t.groups()')) === JSON.stringify(defaultGroups));
check('window sizes differ', (await a.run('innerWidth')) !== (await b.run('innerWidth')));

await a.mark();
await b.mark();
await a.run('t.accent("#ff8800")');
await sleep(3000);

state = await server();

check('change on A reaches the server', hex(state.profile) === '#ff8800', hex(state.profile));
check('A does not reload after its own change', await a.marked());
check('B reloads', !(await b.marked()));
check('B shows the change', hex(await b.run('t.profile()')) === '#ff8800');

const afterChange = state.rev;

await sleep(3000);

check('no echo saves afterwards', (await server()).rev === afterChange);

await b.run('t.button(/^open settings menu$/i)');
await sleep(800);

check('menu is open on B', await b.run('document.documentElement.classList.contains("is-menu-open")'));

const menuRev = (await server()).rev;

check('opening the menu is not synced', menuRev === afterChange, { afterChange, menuRev });

await a.mark();
await b.mark();
await a.run('t.accent("#00cc66")');
await sleep(3000);

check('B waits while its menu is open', await b.marked());

await b.run('t.button(/./, ".menu-close")');
await sleep(3500);

check('B reloads once the menu is closed', !(await b.marked()));
check('B shows the second change', hex(await b.run('t.profile()')) === '#00cc66', hex(await b.run('t.profile()')));
check('A kept its page', await a.marked());
check('closing the menu on B did not overwrite A', hex((await server()).profile) === '#00cc66');

// offline: change on A while the server is unreachable
await a.offline(true);
await a.run('t.accent("#aa00ff")');
await sleep(1500);

check('offline change stays local', hex((await server()).profile) === '#00cc66' && (await a.run('localStorage.getItem("nightTabSyncDirty")')) === '1');

await a.offline(false);
await sleep(7000);

check('offline change is uploaded when the server is back', hex((await server()).profile) === '#aa00ff', hex((await server()).profile));
check('B picked it up', hex(await b.run('t.profile()')) === '#aa00ff');

// clear all data on B
await b.mark();
await a.mark();
await b.run('t.button(/^open settings menu$/i)');
await sleep(800);
await b.run('t.button(/^data$/i, ".menu-nav")');
await sleep(500);
await b.run('t.button(/^clear all data$/i, ".menu")');
await sleep(800);
await b.run('t.button(/^clear all data$/i, ".modal")');
await sleep(5000);

state = await server();

check('clear all resets the server profile to defaults', state.profile !== null && hex(state.profile) === defaultAccent, state.profile && hex(state.profile));
check('A reloads with the defaults', !(await a.marked()) && hex(await a.run('t.profile()')) === defaultAccent);

const clearedRev = state.rev;

await sleep(3000);

check('profile is stable after clearing', (await server()).rev === clearedRev);

// a device that never synced must not push its defaults over an existing profile
await a.run('t.accent("#123456")');
await sleep(2000);

const c = await device('C', 1024, 768);

await c.open();
await sleep(1500);

check('new device takes the existing profile', hex(await c.run('t.profile()')) === '#123456' && hex((await server()).profile) === '#123456');

// global name size: one slider for the names of all bookmarks, synced like everything else
const nameFont = (device) => device.run('parseFloat(getComputedStyle(document.querySelector(".bookmark-display-name")).fontSize)');
const nameFontBefore = await nameFont(c);

await c.run('t.button(/^open settings menu$/i)');
await sleep(800);
await c.run('t.button(/^bookmark$/i, ".menu-nav")');
await sleep(500);
await c.run(`(() => { document.querySelectorAll('.menu input[id^="bookmark-name-size"]').forEach((input) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '200'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }); })()`);
await sleep(2500);

check('the global name size scales the bookmark names', Math.abs((await nameFont(c)) - nameFontBefore * 2) < 0.1, { before: nameFontBefore, after: await nameFont(c) });
check('it is stored in the profile', (await server()).profile.state.bookmark.name.size === 200);
check('other devices show it too', Math.abs((await nameFont(a)) - nameFontBefore * 2) < 0.1, await nameFont(a));

await c.run('t.button(/./, ".menu-close")');
await sleep(800);

// a profile exported from upstream nightTab has no global name size
const upstreamProfile = (await server()).profile;

delete upstreamProfile.state.bookmark.name;

await fetch(APP + 'api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(upstreamProfile) });
await sleep(3500);

check('a profile without the setting falls back to the normal size', Math.abs((await nameFont(c)) - nameFontBefore) < 0.1 && (await c.run('t.groups().length')) > 0, await nameFont(c));

// "open all bookmarks in this group" has to work on a plain web page, where only window.open is available
const openAllProfile = (await server()).profile;

openAllProfile.state.bookmark.newTab = true;
openAllProfile.bookmark.forEach((group) => { group.items.forEach((item, index) => { item.url = APP + 'api/health?' + index; }); });

await fetch(APP + 'api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(openAllProfile) });
await sleep(3500);

const groupSize = openAllProfile.bookmark[openAllProfile.bookmark.length - 1].items.length;
const tabsBefore = await c.tabs();

// first with a pop-up blocker: window.open hands back nothing
await c.run('window.__open = window.open; window.open = () => null;');
await c.run('t.button(/^open all bookmarks in this group$/i)');
await sleep(1000);

check('blocked tabs are reported instead of failing silently', (await c.run('document.querySelector(".modal .modal-heading-text")?.textContent')) === 'Pop-ups are blocked');
check('nothing was opened', (await c.tabs()) === tabsBefore);

// pop-ups allowed, "Try again" opens what was blocked
await c.run('window.open = window.__open;');
await c.run('t.button(/^try again$/i, ".modal")');
await sleep(2000);

check('every bookmark of the group opens in its own tab', (await c.tabs()) - tabsBefore === groupSize, { opened: (await c.tabs()) - tabsBefore, groupSize });
check('the page stays where it is', (await c.run('location.href')) === APP);
check('the group still has all its bookmarks', (await c.run('[...document.querySelectorAll(".group")].pop().querySelectorAll(".bookmark").length')) === groupSize);

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);

socket.close();

process.exit(failed === 0 ? 0 : 1);
