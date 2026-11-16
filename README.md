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

- **Library**: your video folder (Change folder, Rescan now, Open folder), your TMDB key, and copies and versions (see below).
- **Find videos**: see below.
- **Playback**: autoplay next episode, previews, and conversions (see below).
- **App**: sounds, what happens when Couchbox opens, Start with Windows, the right-click menu, updates (with the version number) and What's new.

Kids profiles see only Playback and App. Settings for one title (kids, Fix match) stay on that title's page.

## What's new

**Settings → App → What's new** lists every version, newest first, with what it added, improved and fixed. After an update, a card shows the new version's notes once.

Every version's notes are written once, in `CHANGELOG.md`, using the template at the top of that file (a headline, then New, Improved and Fixed). The app reads them from there, the Update available banner shows the headline, and `tools\release.ps1` uses the entry for the GitHub release notes. It won't publish a version that has no entry.

## Conversions

Videos the built-in player can't play are converted in the background, in your video folder, with the bundled FFmpeg. It's on by default; the switch is in **Settings → Playback → Conversions**.

- **Fast** conversions keep the picture as it is and only convert the sound (for example E-AC3 or DTS to AAC; 5.1 surround stays 5.1). **Slow** ones convert the picture too (AVI, WMV, MPEG-2 and so on). Up to 5 fast and 1 slow run at once, and they carry on while you watch.
- The queue goes in the order videos were added, each series from its first episode to its last. **Queue next** (on a title's page, in the player, or on a row in Settings) moves something to the front. **Pause all** stops everything until **Resume**.
- Each new file is checked before it's used: it opens, its length matches, and the start, middle and end play. Only then does the original move to a hidden `.couchbox-bin` folder inside your video folder and the new file take its place (same name, or `.mp4` for formats like AVI). Progress, My list and kids settings carry over. If a check fails, the original isn't touched and the title shows **Couldn't convert** with **Try again**.
- A binned original is deleted once its new copy has been watched to 90% (on any profile) or after 7 days. Until then, **Restore and retry** puts it back and converts it again, and **Restore and skip** puts it back and leaves it as it is (it's listed under Skipped, with **Convert** if you change your mind). **Empty now** deletes them all.
- Each conversion needs the file's size plus a third free on the drive. If the next one doesn't fit, nothing new starts (running ones finish) and a yellow **!** shows on the menu button, Settings, the Playback tab and the Conversions section. It all starts again by itself once there's room.
- While a film converts, its card is grey with an orange line rising from the bottom; waiting ones are grey with "Waiting". Episodes show the same in the episode list. Kids profiles see the warnings but not the queue or the bin.

## Running in the background

Closing the window hides Couchbox by the clock (the system tray) instead of quitting, so conversions, download checks and folder watching carry on. A playing video pauses when it hides.

- **Tray icon:** the sofa. Grey when idle (light on a dark taskbar, dark on a light one), orange while converting, yellow when something needs attention (such as not enough space). Hover for the status; click or double-click to open Couchbox; right-click for the status, **Open Couchbox**, **Pause conversions** / **Resume conversions** and **Quit**.
- **Quit** is in the tray menu and in the profile menu. If conversions are running it asks first; quitting stops them and deletes their half-made files (originals are never touched), and they start again next time. Windows shutting down never waits for this.
- Only one Couchbox runs at a time: opening it again shows the one already running.
- **Settings → App → Start with Windows** (off by default) starts Couchbox hidden in the tray when you sign in: no window, splash or sounds until you open it.
- While anything is converting, Windows isn't allowed to sleep (the screen can still turn off).
- **Updates:** if conversions are running when an update has downloaded, the banner says "Will update when conversions finish" and no new ones start; it installs as soon as they're done, or straight away with **Update now anyway** (the conversions then start again after the update).

## Downloads

Videos that are still downloading show as **Downloading** instead of ready, and are never converted until they're finished. Couchbox watches new and changed files until they settle:

- A file counts as downloading while it still has a temporary download name (`.crdownload`, `.part`, `.!qB`, `.!ut`; it shows under the name it will have), while another program has it open for writing, or while its size or modified time changed in the last minute.
- Once it has been still for a minute, Couchbox checks the content: it reads, there are no missing (all-zero) pieces as torrent apps leave, an MKV's last frame reaches the end, it isn't far too small for its length and picture size, and short pieces through to the very end play.
- Cards show the poster greyed above a purple line that rises with the download ("Downloading 38%"; just "Downloading" when the size can't be told, as with torrents). Episodes show the same in the episode list.
- Pressing Play on a downloading title opens its page, where the Play button is a purple pie that fills as the file arrives (a turning arc when there's no percentage). Clicking the pie plays what's there so far.
- A file that stops changing but fails the checks (a cancelled download, say) gets a grey **Incomplete** tag. It can still be played as far as it goes, isn't converted, and clears by itself if the download resumes and finishes.
- If a file starts changing while it's being converted, the conversion stops and nothing is replaced.

## Copies and versions

- **Spare copies:** two or more files of the same film or episode, the same length, show as one card. It plays the best copy (highest resolution, then the largest file, then one not named "copy"). **Settings → Library → Copies and versions** lists the spares, with **Move to bin** (into `.couchbox-bin`, restorable for 7 days) or **Keep both**.
- **Versions:** a second file of the same title with a clearly different length (an extended cut, say) gets a yellow **!** and a side-by-side comparison: **Replace the one I have** (the old one goes to the bin; the new one plays from the beginning, and the watched tick, My list and kids settings stay), **Keep the one I have** (the new one goes to the bin), or **Keep both** (both show, labelled by length). A new version that needs converting is converted straight away.

## Right-click menu

Right-click videos or folders in File Explorer and choose **Couchbox → Copy to Couchbox** or **Move to Couchbox** (on Windows 11, under **Show more options**). Folders are searched inside; everything you picked is added, whatever its length, and sorted like Find videos does it. A notification says how many were added, already there or couldn't be added. It works with Couchbox closed (it starts hidden). Turn it off in **Settings → App**; uninstalling removes it.

## Skip intro

Couchbox finds series intros by itself, in the background once nothing is converting: each episode's first 10 minutes of sound is compared with the episodes either side of it in the same season, and a shared stretch of at least 10 seconds is the intro. Short shared clips at the very start (studio logos), a season with one episode, anything after 10 minutes and films are left out. Each episode is checked once, and again only if its file changes.

- **Skip** shows in the player during the intro. Until a season is confirmed it carries a **Guessed** tag.
- After you skip in a guessed season, a small box asks **Was that the intro?** for a few seconds while the video keeps playing (kids profiles are never asked). **Yes** confirms the season: every episode is checked against that intro, and a shortened one skips just its part. **No** pauses and asks whether Skip appeared too soon or too late and skipped too far or not far enough, then goes back to where you pressed Skip and searches that episode again in that direction.

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

How a title is recognised (`src/main/matcher.js`):

- **The name.** As the folder or file name reads (quality tags like 1080p dropped, the last year taken as the year). When there's no other year, a year at the very start followed by a dash or dot ("1942 - Bambi") is taken as the year too; the name is also tried as it is, so a title that is a year ("2001 - A Space Odyssey", "1917") still works.
- **The search.** TMDB films (or series, for a folder of episodes) with the year, then without. If nothing fits well: the part before " - ", then with the last word or two dropped ("Seven Dwarves" finds "Seven Dwarfs").
- **The choice.** Each result gets points for its name, its year (the same, or one or two years off) and its length compared with the video's (a series: its usual episode length). Length is points, never a rule, so a special edition that runs longer still matches, and it tells remakes apart. A result with the same name ranks first unless its year or length clearly don't fit.
- **Not sure?** Below the minimum, nothing is taken: the title goes to **Unmatched**, and **Fix match** lists the best guesses first.
- After an update to these rules, every automatic match is checked once more (`MATCHER_VERSION`); titles picked in Fix match are never touched. Find videos uses the same matching.

If a title gets the wrong poster, open it and click **Fix match**. It shows the file name, folder and a short preview, and searches by year and by films, series or both. Once matched, the file is tidied into `Films\` or `Series\` (unless it's playing or converting, in which case that waits).

Titles Couchbox couldn't be sure of are listed on an **Unmatched** tab (with a count; it's hidden when there are none), each with **Fix match**.

## Features

- Profiles with their own Continue watching, progress and My list, plus kids profiles.
- Profile pictures: in the profile editor, **Choose picture…** opens a JPG, PNG, WebP, GIF or BMP. Drag the square to choose the part you want (drag a corner to resize it, **Rotate** for sideways photos, with live previews), then **Use picture** and **Save**. Couchbox keeps a 200 × 200 copy in `%APPDATA%\Couchbox\avatars`; your original isn't touched. **Remove picture** goes back to the coloured letter.
- Profile lock: a grown-up profile can have a 4-number PIN (**Manage profiles**, edit the profile, **Profile lock → Add PIN**). It's asked, full screen, every time that profile is picked; when it's edited or deleted; and every time Settings is opened on it. Locked profiles show a padlock. Kids profiles can't have a PIN, and once any profile has one, adding a profile or turning a profile's Kids setting off needs a grown-up's PIN (any locked profile's). Five wrong tries in a row mean a 30-second wait. **Forgot PIN?** removes the PIN once Windows Hello (the PC's own PIN, fingerprint or face) confirms it's you, or your Windows password, in Windows' own sign-in window, on a PC without Windows Hello. PINs are stored only as salted hashes (`src/main/pins.js`, `src/main/hello.js`). Reopening Couchbox from the tray stays on the profile you were using.
- Home banner with a muted preview, poster rows, and hover cards that play a preview.
- Series pages with a season picker, episode list, progress, and watched ticks.
- Player with resume, scrub thumbnails, subtitles, speed, skip intro and the next-episode countdown.
- Kids profiles show titles TMDB rates U or PG (or TV-Y, TV-G and similar). From a grown-up profile, open any title to show or hide it for kids.
- Files the built-in player can't handle (AVI, WMV, AC3 or DTS audio, and so on) are converted automatically (see Conversions).

- If the Couchbox window is maximised when you press Play, the video plays full screen. Full screen stays on when you leave the video; leave it with Esc (when nothing else is open), F11 or the button next to search.
- Next episode: a card appears 30 seconds before the end. With autoplay on, a 5-second countdown starts at 20 seconds left and the next episode begins at 15 seconds left; the one you were watching counts as watched. **Watch credits** or **Cancel** stops it, and the countdown then runs at the very end instead. Skipping straight into the last 15 seconds shows the card without jumping.

- Sounds: a theatre organ plays on the splash and a warm chord when the window opens; buttons, tabs, cards, profiles, My list and Settings toggles give a quiet tap (never during a video). In **Settings → App**, under Sounds: opening sounds on or off (whole app), click sounds on or off (each profile has its own), and one volume slider. The sounds are generated by `renderer/sounds.js`; there are no audio files.
- **Settings → App**, under When Couchbox opens: Window (1400 × 860), Maximised, Full screen (the default) or Remember last (size, position, maximised or full screen, as you left it).

Keyboard in the player: Space play/pause, Left/Right skip 10s, Up/Down volume, F full screen, M mute, N next episode, S or Enter skip intro (while Skip shows), Esc back. F11 switches full screen anywhere.

## Where data is kept

`%APPDATA%\Couchbox`: profiles, progress, cached posters, thumbnails and the conversion queue. Delete that folder to reset the app. Couchbox only changes your videos to convert ones that won't play (with the original kept in `.couchbox-bin` for up to 7 days), and when you use Find videos.

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

`test/snap.js` drives the real app against a folder of videos and saves screenshots. `node test/season-folders-check.js` checks season-pack folder names, and `test/season-migrate-check.js` checks settings carry over when split shows merge. `test/avatar-check.js` checks the picture cropper, saving, Cancel, Remove and clean-up. `test/sound-window-check.ps1` checks the sounds and every "When Couchbox opens" choice across several launches. `test/settings-tabs-check.js` checks each Settings tab holds the right settings, still saves them, reopens on the last tab, shows TMDB key problems on Library, and shows kids only Playback and App. `test/conversion-check.js` makes test videos with FFmpeg and checks automatic conversion end to end: the queue order, the 5 + 1 limit, Queue next, the safe swap, a broken file, the bin rules, Restore, Pause, the space warning and kids. `test/background-check.js` checks the tray (colour, status, menu, Pause/Resume), hiding on close while conversions carry on, a file added while hidden, a second launch, Start with Windows (with a stand-in, so it never touches the registry), Quit while converting, and a hidden `--background` start. `test/update-check.js` with `COUCHBOX_UPDATE_WAIT=1` checks an update waits for a running conversion. `test/download-check.js` fakes downloads arriving (growing, temporarily named then renamed, torrent-style filled in out of order, cancelled half way, missing a middle, and changing during a conversion) and checks they show as Downloading or Incomplete, aren't converted early, and become normal once finished. `test/whatsnew-check.js` checks every CHANGELOG entry follows the template, the What's new list and the card after an update. `test/unmatched-check.js` checks the Unmatched tab and Fix match (preview, year and kind search, tidying into Films or Series, waiting while playing). `test/copies-check.js` checks spare copies, the best-copy pick, Move to bin, Keep both, and the three choices for a different version. `test/context-menu-check.js` checks the right-click menu (in a throwaway registry key, never the real one), Copy and Move, folders, already-there files and the notifications. `test/intro-detect-check.js` makes test seasons with a shared theme and checks intro detection (cold opens, logos, a theme broken in the middle, a shortened one, none, after 10 minutes, one-episode seasons, films, not checking twice) and the player's Skip, Guessed, the question, Yes and No. `node test/matcher-check.js` checks the matching against a made-up TMDB (a year at the start, a title that is a year, remakes by length, a wrong year, a special edition, weak answers turned down, the retries, series lengths). `test/rematch-check.js` checks it in the app: the one-time check of earlier matches, Fix match picks left alone, and the best guesses in Fix match. `test/pin-check.js` checks the profile lock: the main-process rules (hashes only, the wait after 5 wrong tries, saves refused without the right PIN, the kids gap) and the app (adding a PIN, the full-screen PIN with the pad and keyboard, Settings, Forgot PIN? with Windows Hello stood in for via `COUCHBOX_HELLO_STUB`, Change and Remove PIN, the tray). `test/click-off-check.js` uses real mouse presses and releases to check that windows and menus only close when both are outside them (including a text selection dragged past a window's edge). All tests mute the app and turn automatic conversion off (`test/quiet.js`), so they never rewrite sample videos. `test/player-check.js` checks auto full screen, Esc/F11/the exit button and the next-episode timings. `test/finder-check.js` runs Find videos against a throwaway test folder (new films, copies, versions, files already in the library, a name clash, Copy, Move and Stop). `test/update-check.js` serves a built installer from a local stand-in release server and walks through the update banner, stopping just before it would install.

The logo (a line-drawn sofa), the app icon and the bold `couchbox` wordmark are defined in `renderer/brand.js`. After editing it, run `node_modules\electron\dist\electron.exe tools/render-icon.js` to regenerate `build/icon.png`, `build/icon-preview.png` and the tray icons in `build/tray/`.

The splash screen is `renderer/splash.html`: a sofa-shaped, see-through window with an orange outline and slowly moving contour lines. To preview it without starting the app, run `node_modules\electron\dist\electron.exe tools/preview-splash.js` for stills, or `tools/record-splash.js` for a short clip. Both write to `build/`.
