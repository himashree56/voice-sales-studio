# Voice Desk

A consent-first AI voice sales assistant demo with live speech-to-text, clear spoken responses, typed replies, optional local call recording, AI-generated summaries and lead outcomes, searchable call history, transcript review, and recording playback.

## Run locally

Serve the folder from localhost (microphone APIs require a secure context):

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>. For AI responses, summaries, and higher-quality generated speech, run the project on Vercel and configure `GEMINI_API_KEY` in the project environment. Without the key, the app uses its in-browser conversation and summary fallback plus a slower, selectable browser voice.

Use a current version of Chrome or Edge and allow microphone access for voice. Browser speech recognition requires an internet connection and may send recognized speech to the browser's speech service. Recording remains optional and requires the explicit consent toggle plus microphone permission. Audio and call history are stored in IndexedDB in the current browser profile.

## Deploy to Vercel

Import this repository into Vercel, set `GEMINI_API_KEY` in Project Settings → Environment Variables, and deploy. The `api/` functions keep the key server-side. AI speech uses Gemini 3.8 Flash-Lite TTS and returns WAV audio; the browser voice remains available in the voice selector. The app is static and requires no database account.

## Notes

- No company name or branding is included.
- This is a browser-based sales demo; it does not place PSTN calls or sync data across devices.
- Browser speech recognition and recording support vary by browser. Typed replies remain available as a fallback.
