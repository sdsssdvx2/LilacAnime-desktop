// The Python side of Whisper (electron/whisper.cjs writes it beside its venv: Python cannot read a file inside the
// app's asar). It reads the episode's audio from stdin as 16 kHz mono s16le, cuts it at quiet moments into pieces of
// at most 30 s (Whisper's window; a cut in the middle of a word would lose it), transcribes each piece with
// whisper.cpp (pywhispercpp) and prints one JSON line per recognized line as soon as it is known:
//   {"start": s, "end": s, "text": "..."}   a line, in the episode's time
//   {"at": s}                               audio read and transcribed up to here
module.exports = String.raw`
import json, re, sys
import numpy as np
from pywhispercpp.model import Model

RATE = 16000
# Japanese out on Windows: its console code page (cp949) cannot write it.
sys.stdout.reconfigure(encoding='utf-8')
model_path, language, threads = sys.argv[1], sys.argv[2], int(sys.argv[3])
start_at = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
model = Model(model_path, n_threads=threads, print_progress=False, print_realtime=False, print_timestamps=False,
              redirect_whispercpp_logs_to=None)

# Lines Whisper is known to make up over music or silence (Japanese YouTube endings, credits).
MADE_UP = ('ご視聴ありがとうございました', 'ご視聴ありがとうございます', 'チャンネル登録', '字幕', 'by H.', 'エンディング',
           'おやすみなさい', 'お疲れ様でした', 'ありがとうございました。', 'Thank you for watching')

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + '\n'); sys.stdout.flush()

recent = []
# Sound captions and music: "(音楽)", "（拍手）", "♪~" alone.
NOT_SPEECH = re.compile(r'^[\s♪♫~〜ー…・.。、!！?？]*$|^[\s]*[(（\[【][^)）\]】]*[)）\]】][\s♪~〜]*$')
def transcribe(samples, offset):
    # A piece with next to no sound is left out: Whisper invents lines over silence.
    if samples.size == 0 or float(np.sqrt(np.mean(samples * samples))) < 0.004:
        return
    for seg in model.transcribe(samples, language=language, no_context=True, suppress_blank=True,
                                temperature=0.0, single_segment=False):
        text = seg.text.strip()
        if not text or NOT_SPEECH.match(text) or any(made in text for made in MADE_UP):
            continue
        # A line said again within the last few is a loop Whisper fell into ("A / B / A / B" over music).
        if text in recent:
            continue
        # A line that is one sign repeated ("あああああ", "ーーーー") is noise.
        if len(set(text.replace(' ', ''))) <= 2 and len(text) > 4:
            continue
        recent.append(text); del recent[:-4]
        emit({'start': round(offset + seg.t0 / 100.0, 2), 'end': round(offset + seg.t1 / 100.0, 2), 'text': text})

def quiet_cut(samples, low, high):
    # The quietest 0.3 s between low and high seconds: where the piece is cut.
    win = int(0.3 * RATE)
    best, best_at = None, int(high * RATE)
    for at in range(int(low * RATE), int(high * RATE) - win, int(0.1 * RATE)):
        part = samples[at:at + win]
        energy = float(np.mean(part * part))
        if best is None or energy < best:
            best, best_at = energy, at + win // 2
    return best_at

buffer = np.zeros(0, dtype=np.float32)
offset = start_at
stdin = sys.stdin.buffer
while True:
    chunk = stdin.read(RATE * 2 * 5)  # 5 s
    if chunk:
        if len(chunk) % 2:
            chunk = chunk[:-1]
        buffer = np.concatenate([buffer, np.frombuffer(chunk, dtype='<i2').astype(np.float32) / 32768.0])
    done = not chunk
    while buffer.size >= RATE * 30 or (done and buffer.size > 0):
        cut = buffer.size if buffer.size < RATE * 30 else quiet_cut(buffer, 18, 30)
        transcribe(buffer[:cut], offset)
        offset += cut / RATE
        buffer = buffer[cut:]
        emit({'at': round(offset, 2)})
    if done:
        break
`;
