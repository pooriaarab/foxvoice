// The toolbar button opens and closes the push-to-talk sidebar.
browser.action.onClicked.addListener(() => browser.sidebarAction.toggle());
