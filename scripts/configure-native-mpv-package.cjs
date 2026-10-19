'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));

pkg.devDependencies ||= {};
pkg.dependencies ||= {};
pkg.build ||= {};
pkg.build.win ||= {};
pkg.build.nsis ||= {};
pkg.build.asarUnpack ||= [];

// V10 no longer uses electron-mpv-video/libmpv frame-copy or shared-texture
// rendering. Keep Electron aligned with upstream Lilac and host the already
// validated mpv.exe window through a tiny Win32 helper.
pkg.devDependencies.electron = '38.2.0';
delete pkg.dependencies['electron-mpv-video'];

// Keep the prototype completely side-by-side with the user's known-good
// LilacAnime installation. It must not overwrite the existing V9 fallback.
pkg.name = 'lilacanime-native-prototype';
pkg.productName = 'LilacAnime Native Prototype';
pkg.build.appId = 'com.lilac.anime.desktop.nativeprototype';
pkg.build.productName = 'LilacAnime Native Prototype';
pkg.build.win.executableName = 'LilacAnimeNativePrototype';
pkg.build.win.artifactName = 'LilacAnime-Native-Prototype-Setup.${ext}';
pkg.build.nsis.shortcutName = 'LilacAnime Native Prototype';

const unpack = new Set(pkg.build.asarUnpack);
unpack.add('node_modules/ffmpeg-static/**');
unpack.add('electron/win32-mpv-host.exe');
pkg.build.asarUnpack = [...unpack];

fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Configured side-by-side V10 raw Win32 hosted-mpv prototype: Electron 38.2.0');
