'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));

pkg.devDependencies ||= {};
pkg.dependencies ||= {};
pkg.build ||= {};
pkg.build.asarUnpack ||= [];

// electron.sharedTexture is used by electron-mpv-video on Windows/macOS.
pkg.devDependencies.electron = '40.10.5';
pkg.dependencies['electron-mpv-video'] = '0.1.1';

const unpack = new Set(pkg.build.asarUnpack);
unpack.add('node_modules/ffmpeg-static/**');
unpack.add('node_modules/electron-mpv-video/native/mpv-addon/build/Release/**');
pkg.build.asarUnpack = [...unpack];

fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Configured native mpv prototype dependencies: Electron 40.10.5 + electron-mpv-video 0.1.1');
