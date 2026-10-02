import { component } from './component';

import { sync } from './component/sync';

import { APP_NAME } from './constant';

console.log(APP_NAME + ' version:', component.version.number, component.version.name);

// the profile lives on the server, fetch it before anything reads localStorage
sync.pull().finally(() => {

  component.data.init();

  component.theme.init();

  component.layout.init();

  component.toolbar.init();

  component.header.init();

  component.group.init();

  component.bookmark.init();

  component.groupAndBookmark.init();

  component.pageLock.init();

  component.keyboard.init();

  // after "clear all data" the defaults the app just started with become the profile
  if (sync.cleared) { component.data.save(); }

  sync.watch();

  // component.menu.open();

});
