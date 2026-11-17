# Native Bigscreen Bridge control

This branch adds a local application control endpoint, independent of the existing
Home Assistant MQTT client. It reuses the Qt WebChannel, router, saved progress and
libmpv player. Existing MQTT topics and payload schemas remain unchanged.

## Interface

Session-bus name/interface: `io.github.shreyasajj.StremioTV.Control`.
Object: `/io/github/shreyasajj/StremioTV/Control`. Method: `Execute(JSON) → JSON`.
The Flatpak grants ownership of this one name. Native builds require Qt DBus.
A D-Bus service-name lease is acquired before creating the window; a secondary
launch asks the existing window for focus and exits without another player.

Requests carry a string `id`, at most 128 characters. JSON is limited to 16 KiB.
The endpoint rejects unknown fields and commands, arbitrary URLs, unsafe content
IDs and nonfinite/negative seek positions. It has no generic shell, JavaScript,
mpv command, credential, configuration or local-file endpoint. The session bus
trusts the logged-in Unix user; the network bridge supplies bearer authentication.

```json
{"id":"request-1","command":"open","content_type":"movie","content_id":"tt0133093"}
{"id":"request-2","command":"open","content_type":"episode","content_id":{"series_id":"tt0944947","video_id":"tt0944947:1:2"}}
{"id":"request-3","command":"pause"}
{"id":"request-4","command":"seek","position":120}
```

Commands: `get_state`, `focus`, `open`, `browse`, `play`, `pause`, `stop`, `seek` (absolute
seconds). `browse` takes `offset` and `limit` (1-50) and lists the stored library,
most recently watched first, without navigating. Content types: `movie`, `series`, `episode`. IDs support alphanumerics,
colon, dot, underscore and hyphen, up to 256 characters; other ID forms are
explicitly rejected. No volume/next/previous support is advertised.

Focus preserves the existing content. Open resolves metadata before changing
content; unknown titles or episodes return errors. Episode navigation chooses its
season and focuses that exact episode. Opening a detail page does not start media.
Set `resume: true` to reuse matching saved progress. Resume returns
`delivery: "stream_selection"` when the existing UI asks the user to choose a
stream; this acknowledgement does not mean playback has started. Missing saved
progress returns `resume_unavailable`. The existing completed-item/next-episode
resume policy remains in effect.

Player commands use the same handler as the remote/MQTT controls. Without an active
player they return `not_playing`. The state reports title, episode label, poster,
content/video ID, position, duration, playback state and UTC observation time.
The added identifiers are not passed to the legacy MQTT publisher.

Mutating calls wait for a renderer acknowledgement, with a bounded timeout and
cancellation signal. A cancelled slow metadata lookup cannot later stop playback
or navigate. Duplicate request IDs return cached responses; changing a request
while retaining its ID is rejected. A busy renderer command returns an error.
Readiness resets on document reload or renderer loss.

## Build and validation

The normal production Flatpak build is
`native/packaging/flatpak/io.github.shreyasajj.StremioTV.yml`. For a user-only
incremental development build on the Linux TV, while 0.8.1 is installed:

```sh
sh native/packaging/build-bridge-flatpak.sh
# Add --install to install the resulting user bundle.
```

This path reuses the installed media libraries, obtains their matching pinned
public headers, and uses the Qt 6.10 SDK/BaseApp development files. It records the
base commit for rollback and builds a bundle in a new user cache directory.
It does not rebuild FFmpeg/mpv or publish anything. Use the full manifest if media
library versions change. Keep profile data in the existing Flatpak app ID.

```sh
node --test test/bridge-protocol.test.js
# Native Qt + libmpv + MQTT + local D-Bus checks in a private test session:
docker build -t bigscreen-stremio-dev native/dev
docker run --rm -v "$PWD":/src -w /src bigscreen-stremio-dev \
  dbus-run-session -- sh native/dev/run-tests.sh
```

The native suite tests actual pause/play/seek/stop, exact movie/episode navigation,
stored-position resume, idempotent commands, duplicate launches, state metadata,
and the existing MQTT regression checks. Mock addon/sample media stay inside the
container; testing must not overwrite the TV's installed addon credentials.
