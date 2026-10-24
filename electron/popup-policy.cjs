// Apply before creating any windows, including hidden provider resolvers.
// App-created BrowserWindows are unaffected; page-created windows are denied.
function installPopupBlocker(app) {
  app.on('web-contents-created', (_, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

module.exports = { installPopupBlocker };
