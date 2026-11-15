# Couchbox

A streaming-style player for the films and series on your own computer.

## Install

Download the latest version from the [Releases page](https://github.com/couchboxsoftware/couchbox/releases/latest):

- `Couchbox-Setup-<version>.exe` installs Couchbox with a Start menu and desktop shortcut. The installed app updates itself (see below).
- `Couchbox-Portable-<version>.exe` runs without installing. Handy on a USB stick. It starts more slowly than the installed version, because Windows unpacks it each time before the splash appears. It can't update itself: when there's a new version it offers to open the download page.

Couchbox isn't code-signed, so Windows may show "Windows protected your PC" the first time, and some antivirus apps scan it before it opens. Click **More info**, then **Run anyway**.

## Updates

A few seconds after it starts (and every 6 hours while it's open), Couchbox checks GitHub Releases for a newer version. If there is one, a banner in the bottom-right corner says **Update available**, with **Update now** and **Later**. **Update now** downloads the new version with a progress bar, then restarts into it. Nothing downloads until you click it. You can also check by hand in **Settings → App**, under Updates.

### Publishing an update

**One-time setup: a GitHub token**

1. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Under **Repository access**, choose **Only select repositories** and pick `couchbox`. Under **Repository permissions**, set **Contents** to **Read and write**.
3. Save it as a Windows user variable called `GH_TOKEN`: press Start, type **environment variables**, open **Edit environment variables for your account**, click **New**, then **OK** in both windows.

**Each release**

```
powershell -File tools\release.ps1 -Bump patch -Notes "Added an Open folder button in Settings."
```

This raises the version (`-Bump patch`: 0.3.0 → 0.3.1; `-Bump minor`: 0.3.x → 0.4.0), builds the installer and portable exe from a short folder path, uploads the matching source to `main`, then uploads the exes, `latest.yml` and blockmap to a GitHub release named after the version, attaches the notes and checks all four files arrived. A copy of just that version is left in `dist\`. The notes appear in the in-app update banner. Add `-NoPublish` to build without uploading anything.

Couchbox is pre-release, so versions stay below 1.0: small updates go `0.3.0` → `0.3.1` → `0.3.2`, and bigger ones `0.3.x` → `0.4.0`. Installed copies only offer an update when the number is higher than theirs, so never publish a `1.x` until you mean to leave 0.x behind.

The repo has to be public so installed copies can read its releases without a password. `node tools/push-source.js "message"` uploads the source on its own (`--dry-run` lists what would go up). Build output, `node_modules` and design previews are left out.

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
- Downloaded season packs can stay as they are: folders like `Desperate.Housewives.S01.1080p…`, `Breaking Bad S01-S03`, `Friends - Season 2` or `Westworld Complete Series` all join one show, with each season in its own place.
- New files show up on their own while Couchbox is open.

## Settings

Open Settings from the profile menu. It has four tabs along the top and reopens on the last one you used (until Couchbox closes):

- **Library**: your video folder (Change folder, Rescan now, Open folder) and your TMDB key.
- **Find videos**: see below.
- **Playback**: autoplay next episode and previews.
- **App**: sounds, what happens when Couchbox opens, and updates (with the version number).

Kids profiles see only Playback and App. Settings for one title (kids, Fix match, skip intro) stay on that title's page.

## Find videos

**Settings → Find videos** searches your computer for videos and adds the ones you pick to your Couchbox folder. Kids profiles don't see it.

1. Choose where to look: the whole computer, Videos, Downloads, Desktop, or folders you add. Couchbox remembers this. Windows, program folders and the Couchbox folder itself are always skipped.
2. Set the length (longer than 20 minutes by default) and the file types, then press **Search**.
3. Each video is checked against TMDB:
   - ✓ green, ticked: recognised and new to Couchbox.
   - ! yellow, ticked: recognised, but more than 30 seconds longer or shorter than a copy you already have, so possibly a different version (for example an extended cut).
   - – grey, unticked: not recognised.
   - Greyed out: already in Couchbox (the same film or episode within 30 seconds of the same length, or the exact same file), or another copy of something in the list. Only the best copy (highest resolution, then largest file) can be added; **Use this copy** picks a different one.
4. Press **Add selected** and choose **Copy** (originals stay) or **Move** (originals are moved; each is copied and checked before the original is removed).

Where added videos go: recognised films to `Films\Title (Year)`, episodes to `Series\Show\Season 01\Show - S01E02`, other lengths with the length added to the name, and unrecognised videos to `Imported\` (their own row on the home screen). Subtitles with the same name go with their video. Nothing is ever overwritten: a clash is skipped and listed in the summary. You need a TMDB key for the ticks; without one, everything is listed unrecognised.

## Posters and descriptions (TMDB)

1. Make a free account at themoviedb.org.
2. Go to Settings, then API, and request an API key (choose "Developer", personal use).
3. Paste the **API Key** or the **API Read Access Token** into Couchbox (on first launch or in **Settings → Library**).

If a title gets the wrong poster, open it and click **Fix match**.

## Features

- Profiles with their own Continue watching, progress and My list, plus kids profiles.
- Profile pictures: in the profile editor, **Choose picture…** opens a JPG, PNG, WebP, GIF or BMP. Drag the square to choose the part you want (drag a corner to resize it, **Rotate** for sideways photos, with live previews), then **Use picture** and **Save**. Couchbox keeps a 200 × 200 copy in `%APPDATA%\Couchbox\avatars`; your original isn't touched. **Remove picture** goes back to the coloured letter.
- Home banner with a muted preview, poster rows, and hover cards that play a preview.
- Series pages with a season picker, episode list, progress, and watched ticks.
- Player with resume, scrub thumbnails, subtitles, speed, skip intro and the next-episode countdown.
- Kids profiles show titles TMDB rates U or PG (or TV-Y, TV-G and similar). From a grown-up profile, open any title to show or hide it for kids.
- Skip intro: in the player, click the gear and mark where the intro starts and ends. It then applies to every episode of that series.
- Files the built-in player can't handle (AVI, WMV, AC3 or DTS audio, and so on) can be converted once with the bundled FFmpeg. The original file isn't changed.

- If the Couchbox window is maximised when you press Play, the video plays full screen. Full screen stays on when you leave the video; leave it with Esc (when nothing else is open), F11 or the button next to search.
- Next episode: a card appears 30 seconds before the end. With autoplay on, a 5-second countdown starts at 20 seconds left and the next episode begins at 15 seconds left; the one you were watching counts as watched. **Watch credits** or **Cancel** stops it, and the countdown then runs at the very end instead. Skipping straight into the last 15 seconds shows the card without jumping.

- Sounds: a theatre organ plays on the splash and a warm chord when the window opens; buttons, tabs, cards, profiles, My list and Settings toggles give a quiet tap (never during a video). In **Settings → App**, under Sounds: opening sounds on or off (whole app), click sounds on or off (each profile has its own), and one volume slider. The sounds are generated by `renderer/sounds.js`; there are no audio files.
- **Settings → App**, under When Couchbox opens: Window (1400 × 860), Maximised, Full screen (the default) or Remember last (size, position, maximised or full screen, as you left it).

Keyboard in the player: Space play/pause, Left/Right skip 10s, Up/Down volume, F full screen, M mute, N next episode, S skip intro, Esc back. F11 switches full screen anywhere.

## Where data is kept

`%APPDATA%\Couchbox`: profiles, progress, cached posters, thumbnails and converted copies. Delete that folder to reset the app. Your videos are never moved or changed.

## Licence

Couchbox is open source under the [MIT licence](LICENSE). Copyright (c) 2026 Couchbox Software.

Couchbox bundles [FFmpeg](https://ffmpeg.org/) (via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)) to convert videos the player can't play. FFmpeg is licensed separately under the GPL; its licence and build details ship next to `ffmpeg.exe` in the app folder, and its source is available from ffmpeg.org. Couchbox is built with [Electron](https://www.electronjs.org/) (MIT).

## Building from source

Needs Node.js.

```
npm install
npm start            # run in development
powershell -File tools\release.ps1 -NoPublish   # build the .exe files into dist\
```

`npm run dist` also builds, but fails with "could not open file" errors when the project folder's path is long; `tools\release.ps1` avoids that by building from a short temporary folder.

`test/snap.js` drives the real app against a folder of videos and saves screenshots. `node test/season-folders-check.js` checks season-pack folder names, and `test/season-migrate-check.js` checks settings carry over when split shows merge. `test/avatar-check.js` checks the picture cropper, saving, Cancel, Remove and clean-up. `test/sound-window-check.ps1` checks the sounds and every "When Couchbox opens" choice across several launches. `test/settings-tabs-check.js` checks each Settings tab holds the right settings, still saves them, reopens on the last tab, shows TMDB key problems on Library, and shows kids only Playback and App. All tests mute the app (`test/quiet.js`). `test/player-check.js` checks auto full screen, Esc/F11/the exit button and the next-episode timings. `test/finder-check.js` runs Find videos against a throwaway test folder (new films, copies, versions, files already in the library, a name clash, Copy, Move and Stop). `test/update-check.js` serves a built installer from a local stand-in release server and walks through the update banner, stopping just before it would install.

The logo (a line-drawn sofa), the app icon and the bold `couchbox` wordmark are defined in `renderer/brand.js`. After editing it, run `node_modules\electron\dist\electron.exe tools/render-icon.js` to regenerate `build/icon.png` and `build/icon-preview.png`.

The splash screen is `renderer/splash.html`: a sofa-shaped, see-through window with an orange outline and slowly moving contour lines. To preview it without starting the app, run `node_modules\electron\dist\electron.exe tools/preview-splash.js` for stills, or `tools/record-splash.js` for a short clip. Both write to `build/`.
