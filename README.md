# Couchbox

A streaming-style player for the films and series on your own computer.

## Install

- `dist/Couchbox-Setup-0.3.0.exe` installs Couchbox with a Start menu and desktop shortcut. The installed app updates itself (see below).
- `dist/Couchbox-Portable-0.3.0.exe` runs without installing. Handy on a USB stick. It starts more slowly than the installed version, because Windows unpacks it each time before the splash appears. It can't update itself: when there's a new version it offers to open the download page.

Windows may show "Windows protected your PC" the first time, because the app isn't code-signed. Click **More info**, then **Run anyway**.

## Updates

A few seconds after it starts (and every 6 hours while it's open), Couchbox checks GitHub Releases for a newer version. If there is one, a banner in the bottom-right corner says **Update available**, with **Update now** and **Later**. **Update now** downloads the new version with a progress bar, then restarts into it. Nothing downloads until you click it. You can also check by hand in **Settings → Updates**.

### Publishing an update

New versions go to the GitHub repo named under `"publish"` in `package.json`.

**One-time setup: a GitHub token**

1. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Under **Repository access**, choose **Only select repositories** and pick `couchbox`. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**. Pick an expiry date, then generate the token and copy it.
3. Save it as a Windows user variable, so you never have to paste it into a terminal: press Start, type **environment variables**, open **Edit environment variables for your account**, click **New**, use the name `GH_TOKEN` and paste the token as the value, then click **OK**.
4. Close and reopen any terminals (and Claude) so they can see the new variable.

**Each release**

```
powershell -File tools\release.ps1 -Bump patch -Notes "Added an Open folder button in Settings."
```

This raises the version (`-Bump patch`: 0.3.0 → 0.3.1; `-Bump minor`: 0.3.x → 0.4.0), saves the notes, builds the installer and portable exe from a short folder path, uploads them with `latest.yml` to a GitHub release named after the version, and leaves a copy of just that version in `dist\`. The notes appear in the in-app update banner. Add `-NoPublish` to build without uploading.

Couchbox is pre-release, so versions stay below 1.0: small updates go `0.3.0` → `0.3.1` → `0.3.2`, and bigger ones `0.3.x` → `0.4.0`. Installed copies only offer an update when the number is higher than theirs, so never publish a `1.x` until you mean to leave 0.x behind.

The repo has to be public so installed copies can read its releases without a password. Each release also uploads the matching source code to the repo's `main` branch (`node tools/push-source.js "message"` does this on its own; `--dry-run` lists what would go up). Build output, `node_modules` and design previews are left out.

## Folder layout

Pick one folder for everything. Couchbox works out what's a film and what's a series from names and folders:

```
Videos\
  Films\
    Night Train (2019).mp4
    Fernhill (2018)\Fernhill.2018.1080p.mkv
  Series\
    The Long Coast\
      Season 01\
        S01E01 - Pilot.mp4
        S01E01 - Pilot.srt        <- subtitles: same name as the video
        S01E02 - The Harbour Master.mp4
      Season 02\
        The.Long.Coast.S02E01.mkv
```

- Put the year in brackets after a film's name to help TMDB pick the right film.
- Episodes need `S01E02`-style numbers (or `1x02`), or must sit in a `Season 1` folder.
- New files show up on their own while Couchbox is open.

## Posters and descriptions (TMDB)

1. Make a free account at themoviedb.org.
2. Go to Settings, then API, and request an API key (choose "Developer", personal use).
3. Paste the **API Key** or the **API Read Access Token** into Couchbox (on first launch or in Settings).

If a title gets the wrong poster, open it and click **Fix match**.

## Features

- Profiles with their own Continue watching, progress and My list, plus kids profiles.
- Home banner with a muted preview, poster rows, and hover cards that play a preview.
- Series pages with a season picker, episode list, progress, and watched ticks.
- Player with resume, scrub thumbnails, subtitles, speed, skip intro and the next-episode countdown.
- Kids profiles show titles TMDB rates U or PG (or TV-Y, TV-G and similar). From a grown-up profile, open any title to show or hide it for kids.
- Skip intro: in the player, click the gear and mark where the intro starts and ends. It then applies to every episode of that series.
- Files the built-in player can't handle (AVI, WMV, AC3 or DTS audio, and so on) can be converted once with the bundled FFmpeg. The original file isn't changed.

Keyboard in the player: Space play/pause, Left/Right skip 10s, Up/Down volume, F full screen, M mute, N next episode, S skip intro, Esc back.

## Where data is kept

`%APPDATA%\Couchbox`: profiles, progress, cached posters, thumbnails and converted copies. Delete that folder to reset the app. Your videos are never moved or changed.

## Licence

Couchbox is open source under the [MIT licence](LICENSE). Copyright (c) 2026 Couchbox Software.

## Building from source

Needs Node.js.

```
npm install
npm start            # run in development
powershell -File tools\release.ps1 -NoPublish   # build the .exe files into dist\
```

`npm run dist` also builds, but fails with "could not open file" errors when the project folder's path is long; `tools\release.ps1` avoids that by building from a short temporary folder.

`test/snap.js` drives the real app against a folder of videos and saves screenshots. `test/update-check.js` serves a built installer from a local stand-in release server and walks through the update banner, stopping just before it would install.

The logo (a line-drawn sofa), the app icon and the bold `couchbox` wordmark are defined in `renderer/brand.js`. After editing it, run `node_modules\electron\dist\electron.exe tools/render-icon.js` to regenerate `build/icon.png` and `build/icon-preview.png`.

The splash screen is `renderer/splash.html`: a sofa-shaped, see-through window with an orange outline and slowly moving contour lines. To preview it without starting the app, run `node_modules\electron\dist\electron.exe tools/preview-splash.js` for stills, or `tools/record-splash.js` for a short clip. Both write to `build/`.
