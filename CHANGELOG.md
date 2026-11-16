<!--
  Every Couchbox version, newest first. Couchbox shows this in Settings, App (What's new) and
  after an update; the release script uses the entry for the GitHub release notes, and the
  Update available banner shows its headline. Write each entry like this:

  ## 1.2.3 · 15 Nov 2026
  One short sentence, in plain words: what you'll notice.

  ### New
  - Things you couldn't do before. One sentence each, present tense.

  ### Improved
  - Things that work better.

  ### Fixed
  - Things that were wrong.

  Rules: three-part version; the date as "15 Nov 2026"; the groups in this order, leaving out
  empty ones; each line starts with the thing itself; say where a setting is, like
  "(Settings, App)"; no tests, code or file names.
-->

## 0.3.11 · 16 Nov 2026
Grown-up profiles can be locked with a PIN.

### New
- Profile lock gives a grown-up profile a 4-number PIN, asked when it's picked, when it's changed and when Settings is opened on it (Manage profiles, edit the profile).
- Locked profiles show a padlock on Who's watching. Kids profiles can't have a PIN.
- Once a profile has a PIN, adding a profile or turning a profile's Kids setting off needs a grown-up's PIN.
- Forgot PIN? removes it after Windows Hello confirms it's you, or your Windows password on a PC without Windows Hello.
- After 5 wrong tries in a row, there's a 30-second wait.

## 0.3.10 · 16 Nov 2026
Couchbox recognises far more of your films by themselves.

### Improved
- Names that start with the year, like "1942 - Bambi", are understood.
- Each video's length is compared with TMDB's, so remakes with the same name are told apart and a wrong year in a file name is put right.
- Names that don't quite match TMDB's, like "Seven Dwarves" or extra words after a dash, are found by searching again with less of the name.
- When Couchbox isn't sure, the title stays in Unmatched instead of getting the wrong poster, and Fix match lists its best guesses first.
- After this update, every title Couchbox matched by itself is checked once more; titles you picked in Fix match stay as they are.
- Find videos recognises videos the same way.

## 0.3.9 · 15 Nov 2026
Windows no longer close when you drag out of them.

### Fixed
- Windows like a film's details, Fix match and Settings only close when you press and let go outside them, so selecting text and letting go past the edge keeps the window and your selection.
- The profile menu and the player's menus work the same way.

## 0.3.8 · 15 Nov 2026
Couchbox keeps working after you close it.

### New
- Closing the window keeps Couchbox running by the clock, so conversions carry on.
- The sofa by the clock turns orange while converting and yellow when something needs attention; right-click it to pause conversions or quit.
- Start with Windows starts Couchbox hidden by the clock (Settings, App). It's off unless you turn it on.
- Quit Couchbox is in the profile menu. It asks first if conversions are running.
- What's new lists every version and what it added (Settings, App), and a card shows what's new after an update.
- An Unmatched tab lists the films and series TMDB couldn't recognise, so you can match them yourself.
- Spare copies of the same film or episode show as one card, playing the best copy; Move to bin or Keep both (Settings, Library, Copies and versions).
- A second version with a different length, like an extended cut, gets a yellow ! and a side-by-side comparison: Replace the one I have, Keep the one I have, or Keep both.
- Right-click videos or folders in File Explorer and choose Couchbox, then Copy or Move to Couchbox (on Windows 11, under Show more options). You can turn it off (Settings, App).
- Skip appears by itself during a series' intro, found by comparing episodes of the same season. Until you confirm a season it says Guessed, and after you skip it asks "Was that the intro?".

### Improved
- Fix match shows the file and a short preview, searches by year and by films, series or both, and tidies the file into Films or Series once it's matched.
- Updates wait for running conversions to finish, or you can update straight away.
- Your computer doesn't go to sleep while videos are converting.
- Opening Couchbox again shows the one that's already running.
- Enter presses Skip while it's showing. Marking intros by hand with the gear button is no longer needed, so it's gone.

## 0.3.7 · 15 Nov 2026
Couchbox spots videos that are still downloading.

### New
- Downloading videos show a purple line rising over the poster, and the Play button becomes a pie that fills as the file arrives.
- Downloads that stopped part way get an Incomplete tag.

### Improved
- Videos aren't converted until they've finished downloading.

### Fixed
- New files show up while they're still downloading, not only once they've finished.

## 0.3.6 · 15 Nov 2026
Videos that won't play are converted for you.

### New
- Automatic conversion in the background, five quick ones and one slow one at a time (Settings, Playback, Conversions).
- Each converted file is checked before it replaces the original, and the original waits in a bin until you've watched the new copy, or for 7 days.
- A yellow ! tells you when the drive is too full to carry on converting.
- Cards turn grey with an orange line that rises as a video converts.

## 0.3.5 · 15 Nov 2026
Settings is easier to find your way around.

### Improved
- Settings is split into four tabs: Library, Find videos, Playback and App.
- Settings reopens on the tab you used last.
- Kids profiles see only Playback and App.

## 0.3.4 · 15 Nov 2026
Shows downloaded as season packs appear as one show.

### Fixed
- Folders like "Show.S01.1080p", "Show S01-S03" or "Show - Season 2" now make one show with all its seasons, instead of a separate card per season.

## 0.3.3 · 15 Nov 2026
Couchbox has sounds, opening choices and profile pictures.

### New
- A cinema organ when Couchbox starts, a warm chord when it opens, and quiet click sounds you can turn off for each profile (Settings, App).
- Choose how Couchbox opens: in a window, maximised, full screen, or as you left it (Settings, App).
- Profile pictures: choose a photo and pick the square you want.

## 0.3.2 · 14 Nov 2026
Find videos brings films and series in from anywhere on your computer.

### New
- Find videos searches your computer, ticks the videos it recognises, and copies or moves them into Couchbox without duplicates (Settings, Find videos).

### Improved
- Videos play full screen when Couchbox is maximised.
- The next episode starts 15 seconds before the end.

## 0.3.1 · 14 Nov 2026
Open your video folder straight from Couchbox.

### New
- An Open folder button next to Rescan now (Settings, Library).

## 0.3.0 · 14 Nov 2026
Couchbox updates itself.

### New
- Couchbox checks for new versions and installs them when you choose Update now.
- A new splash screen and the sofa logo.
