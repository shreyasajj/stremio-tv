# Home & episode UI changes

Three remote-control UI changes to the web UI (`ui/`):

| # | Request | What changed |
| --- | --- | --- |
| 1 | Pressing Left enough on Home should land on the sidebar and stay there | The nav rail is now a hard edge: Left, Up and Down never leave it |
| 2 | Past Continue Watching, drop the title card and show three rows at once (New releases, Drama, …) | Home has a browse mode: the hero fades out, rows slide up and three poster rows fill the screen. New Releases and genre rows were added |
| 3 | Show when a series' next episode comes out | A "Next episode" line on the detail page and the home hero, and a badge on Continue Watching cards |

## 1. The sidebar stays focused

**Cause.** Every row on Home is wider than the screen and remembers its own horizontal scroll. Cards scrolled past the content edge are still laid out, just hidden behind the nav rail. They sit to the left of the rail's icons, so the spatial nav engine picked them as the best target for Left. Pressing Left on the sidebar jumped back into a row and scrolled it again. Up/Down at the top or bottom of the rail could also drop into the content.

**Fix.**

- `#sidebar` gets `data-nav-stop="left up down"` ([ui/index.html](../ui/index.html)).
- In [ui/js/nav.js](../ui/js/nav.js), `move()` checks whether focus sits inside a `[data-nav-stop]` container that lists the pressed direction. If it does, only candidates inside that container count. Right still leaves the rail as before.

The attribute is generic, so any other panel can opt in the same way.

## 2. Home browse mode: three rows, no hero

**Behaviour.**

- While focus is on the first row (Continue Watching, or the first catalog when there is none), Home looks as before: hero on top, Play/Details one press Up.
- When focus moves to any lower row, `.home-screen` gets the class `browsing`. The hero text and backdrop fade out, and the focused row pins to the TV-safe top edge. Three rows then fit on screen.
- Moving back up to the first row scrolls to the top and the hero fades back in.
- While browsing, the hero is `inert`, so the nav engine skips its hidden buttons. `isVisible()` in `nav.js` now treats `[inert]` like `.hidden`. The hero also stops fetching metadata for cards it would not show.

**Layout** ([ui/css/tv.css](../ui/css/tv.css)).

- `.home-rows` now covers the whole screen. Before, it started at `top: 52vh`. The first row is pushed below the hero with `padding-top: 52vh`, so the rows really scroll up over the hero area instead of animating `top`. Animating `top` would relayout every frame, which is risky on TV boxes with software GL.
- `scroll-padding-top: var(--safe-y)` says where later rows pin. In `nav.js`, `data-scroll="start"` containers now scroll the first section to 0 and later sections to that padding.
- The container ignores pointer events and its children accept them, so the mouse can still reach the hero buttons under the padding.
- Poster width on Home is computed so that exactly three rows fit:

  ```
  --poster-w = ((100vh − safe-y) / 3 − 119px) × 2/3
  ```

  The 119px is the row title (43px), top padding (24px), bottom padding (48px, down from 60px on Home) and the section gap (4px). At 1080p, posters are about 148px wide instead of 200px. Continue Watching's 16:9 cards stay at 400 × 225px, the same height as a poster row.

**New rows** ([ui/js/screens/home.js](../ui/js/screens/home.js)).

| Row | Source |
| --- | --- |
| Continue Watching | Unchanged |
| Addon catalogs (up to 8) | As before. Catalogs that *require* a genre now open on their first option instead of failing. With Cinemeta this turns the "New" catalogs into New Releases rows for the newest year (movie · 2026, series · 2026) |
| Drama, Comedy, Action, Thriller, Sci-Fi | The first movie catalog that can filter by genre (Cinemeta's Popular), one row per genre it offers, in that order |

The genre list lives in `GENRE_ROWS` at the top of `home.js`.

## 3. Next episode release date

New helpers in [ui/js/art.js](../ui/js/art.js):

- `nextEpisode(meta)` finds the earliest episode whose `released` date is in the future. It skips specials (season 0).
- `releaseDay(time)` formats it as *Today*, *Tomorrow*, *Friday, Nov 6* (within a week) or *Nov 14* (with the year if it's not this year).
- `nextEpisodeText(meta)` combines them, e.g. `S2 E3 · Friday, Nov 6`.

Where it shows:

| Place | How |
| --- | --- |
| Series detail page | Line under the fact chips: calendar icon, "Next episode", `S2 E3 · Friday, Nov 6` (`nextEpisodeLine()` in `ui.js`) |
| Home hero | Same line under the facts. Series always fetch their full meta (cached) so the episode list is available |
| Continue Watching cards | Purple badge in the top-left corner of the wide card, from the series' full meta |

Nothing shows for movies, ended series, or series whose addon gives no release dates.

## Testing

`node test/ui-test.js` (run in the `stremio-tv-uitest` container): **80/80 checks pass**. New checks:

- Down past the first row hides the hero.
- Three rows are fully on screen while browsing (posters within the viewport).
- Genre rows are listed.
- Up to the first row brings the hero back.
- Left on the rail stays on the rail.
- Down at the bottom of the rail stays on the rail.
- The series detail page shows when the next episode airs.

The mock addon's S2 E3 now airs three days after the test runs, so the next-episode path is exercised.

## Trade-offs and open questions

- **Smaller posters on Home** (about 148px instead of 200px at 1080p) are the price of three rows. Discover and Library keep the 200px size.
- **The hero only describes row one.** While browsing you see the focused card's name but no synopsis. A compact info strip could be added if that's missed.
- **Which genres?** The defaults are Drama, Comedy, Action, Thriller and Sci-Fi. They could become a setting.
- **Release times** come from the addon and are often midnight UTC, so the day can be off by one in some time zones.
- **Not yet tested on the native Qt shell** (`test/native-test.js`). The changes are pure web UI, but the scroll-over-hero effect is worth a look on real TV hardware.
