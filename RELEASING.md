# Releasing Stitch Editor

Stitch Editor checks https://github.com/adjustablepen/StitchEditor/releases/latest every time it opens.
If the release tag (e.g. `v0.3.0`) is newer than the installed version, it asks:
**Install now** · **Remind me later** (or ×, asks again next launch) · **Skip this version**.

## Publishing a new version
1. Bump `"version"` in `package.json` (e.g. 0.2.0 → 0.3.0).
2. Run `npm run pack-update` → creates `dist/StitchEditor-update-v0.3.0.zip`.
3. On GitHub: Releases → *Draft a new release* → tag `v0.3.0`, write the notes (they show in the update prompt),
   attach the update zip **and** `StitchEditor-Setup-v0.3.0.exe` (the installer for new users) → *Publish*.
   Build the installer with `BASE_ZIP=StitchEditor-Windows-v0.3.0.zip tools/build-installer.sh` (needs NSIS).
   The updater only looks for the asset with "update" in its name, so the Setup.exe never confuses it.

The update zip only contains the app's own files (`main.js`, `preload.js`, `package.json`, `src/`, `build/`),
so updates are small. The Setup.exe is only needed for brand-new installs.

## The installer
- Installs per-user to `%LOCALAPPDATA%\Programs\Stitch Editor` - no admin prompt, and the auto-updater can write there.
- Adds a Start Menu entry (so it shows in Windows search), optional desktop shortcut, and an entry in
  *Settings → Apps → Installed apps* for uninstalling. Running a newer Setup over an old install upgrades it in place.
- Uninstalling asks whether to also delete settings/autosave (`%APPDATA%\Stitch Editor`).

## Keeping it "public but nobody can contribute"
Only you (and collaborators you add) can push. In Settings you can untick *Issues*, and under
*Moderation options → Interaction limits* restrict who can open pull requests or comment.
