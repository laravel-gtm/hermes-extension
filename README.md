# Hermes LinkedIn Capture (Chrome Extension)

Internal Chrome extension for the Hermes team. While viewing a LinkedIn profile,
click the extension and hit **Add profile to Hermes** — the profile URL is sent
to the Hermes app (`https://hermes.laravel-demo.cloud`) under your account.

This extension is **internal-only** and is never published to the Chrome Web
Store. It's distributed as a zip file and installed manually (takes about a
minute, instructions below).

## Installing the extension

1. **Download the zip** you were given (e.g. `hermes-extension-v1.0.0.zip`).
2. **Unzip it** by double-clicking the file. You'll get a folder — put it
   somewhere permanent (e.g. your Documents folder). **Don't delete this folder
   later**; Chrome loads the extension from it every time it starts.
3. In Chrome, open **`chrome://extensions`** (paste that into the address bar).
4. Turn on **Developer mode** — the toggle in the top-right corner.
5. Click **Load unpacked** (top-left) and select the folder you unzipped.
6. The **Hermes LinkedIn Capture** extension appears in the list. Click the
   puzzle-piece icon next to Chrome's address bar and **pin** it so it's always
   visible.

### Signing in (first run)

1. Click the extension icon.
2. Click **Sign in with Google** and complete the usual Google sign-in for your
   work account. The window closes by itself when it's done.
3. That's it — the popup now shows who you're signed in as. You only do this
   once; the extension stays signed in.

### Using it

1. Browse LinkedIn like normal.
2. When you're on someone's profile page (`linkedin.com/in/...`), click the
   extension icon.
3. Click **Add profile to Hermes**. You'll see a confirmation — either
   *"Profile queued for Hermes"* or *"Profile already added"* if someone beat
   you to it.

On any other page, the popup just shows your signed-in account. Use
**Sign out** in the popup if you need to switch accounts.

### Troubleshooting

- **"Sign-in was cancelled"** — you closed the Google window before finishing;
  just click Sign in again.
- **Signed out unexpectedly** — your token was revoked or expired. Sign in
  again.
- **The extension disappeared from Chrome** — the unzipped folder was moved or
  deleted. Put it back (or re-unzip) and repeat the install steps.

## Development

The extension source lives in [`extension/`](extension/) — vanilla JS, Manifest
V3, no build step. Load `extension/` itself via *Load unpacked* while developing;
changes to the popup are picked up on next open (click ↻ on the extensions page
after editing the manifest).

- `extension/js/config.js` — hardcoded app base URL and storage keys.
- The extension ID is pinned to `acddngimkgljedjnlbdjnlahoafbchni` via the
  `key` field in `manifest.json`, so the OAuth callback URI
  (`https://acddngimkgljedjnlbdjnlahoafbchni.chromiumapp.org/callback`) is
  stable for every install. The matching private key (`key.pem`) is gitignored
  and only needed if we ever produce a `.crx`; keep it out of the repo.
- The API the Hermes app must implement is specified in
  [`docs/api-contract.md`](docs/api-contract.md).

### Building a release zip

```bash
./scripts/build-zip.sh
```

Writes `dist/hermes-extension-v<version>.zip` (version read from the manifest).
Bump `"version"` in `extension/manifest.json` before cutting a new release,
then share the zip with the team.
