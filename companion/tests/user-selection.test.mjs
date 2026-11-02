import test from 'node:test';
import assert from 'node:assert/strict';
import { userSubtitleEpisodeHint, isUserSubtitleCompatibleWithEpisode } from '../src/subtitles/user-selection.mjs';

test('user subtitle episode hint understands synced Bleach-style filenames', () => {
  const file = 'C:\\Users\\user\\AppData\\Roaming\\lilacanime-desktop\\subtitles\\user\\123\\[KaMi]_(Hi10)_Bleach_-_001_(480p)_(Arigatou).sync-abc.vtt';
  assert.equal(userSubtitleEpisodeHint(file), 1);
});

test('a previous-episode synced subtitle is rejected after moving to the next episode', () => {
  const file = 'C:\\Users\\user\\AppData\\Roaming\\lilacanime-desktop\\subtitles\\user\\123\\[KaMi]_(Hi10)_Bleach_-_001_(480p)_(Arigatou).sync-abc.vtt';
  assert.deepEqual(isUserSubtitleCompatibleWithEpisode(file, 1), { compatible: true, hintedEpisode: 1 });
  assert.deepEqual(isUserSubtitleCompatibleWithEpisode(file, 2), { compatible: false, hintedEpisode: 1 });
});

test('a subtitle with no episode number remains eligible as an explicit user choice', () => {
  const file = 'C:\\Subs\\movie-special-korean.srt';
  assert.deepEqual(isUserSubtitleCompatibleWithEpisode(file, 7), { compatible: true, hintedEpisode: null });
});
