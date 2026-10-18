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

// electron.sharedTexture is used by electron-mpv-video on Windows/macOS.
pkg.devDependencies.electron = '40.10.5';
pkg.dependencies['electron-mpv-video'] = '0.1.1';

// Keep the first inline-player candidate completely side-by-side with the
// user's known-good LilacAnime installation. It must not overwrite V9.
pkg.name = 'lilacanime-native-prototype';
pkg.productName = 'LilacAnime Native Prototype';
pkg.build.appId = 'com.lilac.anime.desktop.nativeprototype';
pkg.build.productName = 'LilacAnime Native Prototype';
pkg.build.win.executableName = 'LilacAnimeNativePrototype';
pkg.build.win.artifactName = 'LilacAnime-Native-Prototype-Setup.${ext}';
pkg.build.nsis.shortcutName = 'LilacAnime Native Prototype';

const unpack = new Set(pkg.build.asarUnpack);
unpack.add('node_modules/ffmpeg-static/**');
unpack.add('node_modules/electron-mpv-video/native/mpv-addon/build/Release/**');
pkg.build.asarUnpack = [...unpack];

fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Configured side-by-side native mpv prototype: Electron 40.10.5 + electron-mpv-video 0.1.1');
