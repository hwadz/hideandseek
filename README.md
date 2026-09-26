# Hide & Seek — a multiplayer gamemode for PolyTrack 0.6.3

A PolyModLoader mod. One player is the seeker and sits behind a black screen
while everyone else scatters; when the timer runs out the seeker is released
and has to drive into the hiders.

It doubles as a tag gamemode — the same round machinery runs three rule sets.

Requires **PolyTrack / PolyModLoader 0.6.3**. (0.6.2 was supported up to mod
version 1.1.0; that build is still in the git history but is no longer offered,
because the minified names the mixins anchor to differ between the two.)

---

## Installing

Open PolyModLoader 0.6.3 (the launcher, or <https://w.polymodloader.com>), go to
**Mods → Add**, paste this URL, then press **Apply**:

```
https://cdn.polymodloader.com/gh/hwadz/hideandseek/main
```

That is PML's CDN form `…/[gh|cb|gl|bb]/<owner>/<repo>/<ref>[/path]` — `gh`
= GitHub, `cb` = Codeberg, `gl` = GitLab, `bb` = Bitbucket — pointed at
whichever folder holds `manifest.json`, which here is the repo root. If you
fork or move the repo, change the owner/repo/ref to match.

### If a fresh push does not show up

The CDN caches `manifest.json` for a branch ref with `max-age=14400` (4 hours),
and it ignores both `?cache-busting` query strings and `Cache-Control:
no-cache`. So for a while after a release the branch URL can still hand out the
previous version list, even though the new version's files are already being
served.

`<ref>` accepts a **commit SHA**, which is a distinct cache key and therefore
always fresh:

```
https://cdn.polymodloader.com/gh/hwadz/hideandseek/5ef960d
```

That pins the install to that commit and will not auto-update, so it is the
thing to use right after a push (or for a reproducible install), not the URL to
hand out generally.

To iterate locally, serve this folder over HTTP, open <https://w.polymodloader.com>,
add `http://localhost:<port>` as a mod, and turn **cache mods** off in the PML
settings.

**Everyone in the lobby needs the mod.** The host only sends round state to
peers that advertised it during the join handshake, so a vanilla player simply
stays a spectator — they are never kicked and the lobby still works.

## Playing

1. **Multiplayer → Host**, and pick **Hide & Seek**, **Infection** or **Tag**
   in the *Game Mode* row, next to Casual and Competitive.
2. Choose a track and host. The round starts by itself once at least two
   players with the mod have joined, and a new one starts after each result
   while *Start another round automatically* is on.
3. The host can also press **N** at any time to start or stop a round by hand
   — including during a plain Casual or Competitive session.
4. Once you are caught, press **V** to ride along with the seeker's camera —
   press it again to cycle seekers, and once more to go back to your own car.
4. Round rules come from the **host's** Settings → Hide & Seek. Everyone
   else's copies of those settings are ignored; only their local preferences
   (HUD, sounds, warnings) apply.

Big open tracks work far better than narrow circuits.

## Modes

| Mode | Getting caught | Win condition |
| --- | --- | --- |
| **Hide & Seek** (default) | You are eliminated and become a ghost | Last hider standing wins. Everyone caught → seekers win. Clock runs out → survivors win. |
| **Infection** | You join the seekers | Seekers win by catching everybody, hiders win on the clock. |
| **Tag** | You become the new (only) IT | Least total time as IT when the clock runs out. |

## Fairness

Both things the gamemode obviously needs, plus the ones it turns out to need
after a couple of rounds:

- **Skid marks off** while a round runs. They paint a trail straight to a hider.
- **Name tags off** while a round runs. They are visible through the whole map.
- **The seeker is blindfolded, frozen and muted** during the hiding phase, so
  they cannot creep forward or listen for engines. A countdown is drawn on the
  black screen.
- **Everyone starts** when the round does, so nobody is left stacked on the
  spawn point (the game hides all but one car that has not started yet).
- **Off-track resets.** Touching the grass for more than a third of a second
  puts you back on the start line, so hiders have to use the track instead of
  parking in the terrain. There is a cooldown so a bad landing cannot loop it,
  and a brief clip of a corner does not count.
- **Catch cooldown** (default 3 s) after every catch.
- **Respawn immunity** (1.5 s) so the start line cannot be camped.
- **No instant tag-backs** in tag mode (5 s).
- **Seekers are picked at random**, preferring players who did not seek last
  round, and the count scales with lobby size (1 per 5 players, up to 3).
- **Proximity warning** — hiders get a red glow that grows as a seeker closes in.
- **Seeker radar** — in the last third of the round the seeker gets a compass
  bearing and distance to the nearest hider, so rounds actually end.
- **Catches respect height**, so nobody is caught through the floor of a bridge.
- **Eliminated players free-roam as translucent ghosts** and can neither catch
  nor be caught. Remote cars carry no physics in PolyTrack, so they cannot
  body-block either. They can also watch the seeker's camera with **V** —
  deliberately *not* available to a hider who is still in the round.
- **A random community track between rounds**, so a lobby does not spend the
  evening on one map. The last few played are skipped.
- **The personal-best popup is suppressed** so a hider crossing the finish line
  does not get their screen taken over.
- **Disconnects are handled**: leavers drop out of the round, and if every
  seeker quits a hider is promoted rather than letting the round stall.

## Settings

Under **Settings → Hide & Seek**. Host-side (round rules): Gamemode, Hiding
time, Round length, Seekers, Catch range, Catch cooldown, Warning range, Start
another round automatically, Reset to the start on grass, Random community
track each round. Client-side (local preference): Hide name tags,
Hide skid marks, Warn hiders when a seeker is close, Seeker radar late in the
round, Sound cues, Show the Hide & Seek HUD.

Keybinds under **Controls → Hide & Seek**: Start / stop round (**N**) and
Watch the seeker (**V**). `H` was not available — PolyTrack already uses it
for Toggle UI.

---

## How it works

### The host decides everything

PolyTrack multiplayer is a star topology: every client sends its car state to
the host, and the host relays it to everyone else. The host therefore already
has every car position, so it is the only place where catches can be judged
consistently. It owns the round — roles, phase, timers, catches — and
broadcasts the state 5×/s over the reliable data channel. Clients only render
what they are told.

Clients never send anything back. That matters: PolyTrack reserves message id
`255` (`ModCustomMessage`) on both peer channels for mods, but the case is
empty, which means the payload is never consumed — the caller's "leftover
data" check then fires and **closes the connection**. So a mod message to a
vanilla peer disconnects them. The host avoids that by only sending to peers
whose join handshake advertised this mod (PML fills the handshake's `mods`
array with `<modId>:<version>` for every loaded mod), and clients avoid it by
never initiating.

Proximity warnings and the seeker radar are computed on each client from the
car positions it already has locally, so they cost nothing on the wire and stay
smooth between broadcasts.

### Why the gamemodes are not real game mode values

The obvious implementation is to add `HideAndSeek` to the game's own multiplayer
game mode enum. That breaks the lobby. The enum value travels in the NewSession
message, and a client that does not recognise it logs `Unknown gameMode value`
and **closes the connection**; two further places do
`default: throw new Error("Unknown multiplayer game mode")`.

So a session hosted in one of these modes is still a **Casual** session as far
as the game and the wire protocol are concerned. The buttons only record the
choice locally on the host, and the real mode reaches the other players over
the mod's own message channel along with the rest of the round state. That also
keeps a vanilla player's join working — they simply spectate.

### Mixins

Ten global mixins, all registered in `preInit` — see `2.1.0/main.mod.js`, each
one commented in place.

| # | Anchor | Why |
| --- | --- | --- |
| 1 | `setNameTag` | Teach it that a null name means *remove the tag*. Stock always stores an object, so the sprite would be rebuilt reading `"null"`. |
| 2 | Skid-mark `spawn` | Drop skid marks at the source while a round runs. |
| 3 | `case <c2h>.ModCustomMessage` | Host-side receive, and consume the payload. |
| 4 | `case <h2c>.ModCustomMessage` | Client-side receive, and consume the payload. |
| 5 | `kickPlayer` | Adds `hnsSend` / `hnsModdedIds` to the host connection class. |
| 6 | the opacity-pass call in `update()` | The per-frame hook, placed after every car has moved. Also hands over a small bridge to the session internals the mod needs: the track (`getPartsAt`), the track library, the renderer's `setCamera`, whether the free camera is flying, and the reset-to-start action. |
| 7 | `for (const t of o.mods)` | Host-side: note whether a joining peer runs the mod. |
| 8 | `isOfferSet: !1,` | Store that flag on the peer record. |
| 9 | game session `dispose` | Tear the round down when the track is left. |
| 10 | the `info` line of the Game Mode row | Add the gamemode buttons to the Host Multiplayer screen. |

Global mixins are string surgery on PolyModLoader's own prettier-formatted copy
of `main.bundle.js`, not on the minified bundle that ships in the game's asar —
the tokens are written against PML's copy and every one of them is unique in it.

### Porting between game versions

The minified identifiers move every release, so each mod version is pinned to
one game version. Going 0.6.2 → 0.6.3 needed these renames, and nothing else:

| Meaning | 0.6.2 | 0.6.3 |
| --- | --- | --- |
| name-tag field on the car | `Ae` | `ve` |
| client→host message enum | `Yt` | `en` |
| host→client message enum | `$t` | `nn` |
| host's connected-peer array | `Tn` | `_n` |
| game session method set | `jr` | `ta` |
| per-frame opacity pass | `vs` | `Cs` |
| local car | `Fa` | `Xa` |
| remote car map | `Ja` | `as` |
| multiplayer session info | `Wa` | `Za` |

Car geometry (`detectorBoxSize` 0.89 × 0.22 × 1.8, wheels at ±0.72 / ±1.53) and
`maxFrames` are identical across the two, so the catch-distance tuning carries
over unchanged.

### Testing

Each version is verified against the PolyModLoader release it targets. Two
offline harnesses live in the scratch directory used to build it:

- one replays PML's own mixin algorithm over `globalFunc` for **both** mod
  versions, asserts each token is found *exactly once* (ambiguous tokens fail,
  not just missing ones), re-parses the ~3.5 MB patched result, and checks that
  every minified identifier the injected code names actually exists in that
  bundle — which is what catches a rename like `Ae` → `ve`;
- one runs two module instances (a host and a client) against fake cars and a
  fake peer link: 47 checks covering role assignment, the phase machine,
  catches, cooldowns, respawn immunity, height separation, all three modes,
  disconnects, HUD render and teardown.

- a third executes the Game Mode row snippet against a toy DOM with the same
  locals the real call site has, so the button wiring is run rather than just
  parsed: labels, highlight handoff, description text, and that picking a mod
  gamemode leaves the wire value on Casual.

All three pass (10 mixins, 59 logic checks, 18 UI checks). What they cannot
cover is anything that needs a real lobby: live WebRTC, the signalling server,
and how the round feels at real ping. Play-test before relying on it.

### Telling road from grass

Track parts sit on a grid of 5 world units and the track keeps a
position → parts map, exposed as `getPartsAt(x, y, z)`. "On the grass" is
therefore: the wheels are touching something, and none of the cells they touch
holds a track part. The cell below each contact point is checked too, because
a contact sits on a part's top face and that lands on a cell boundary. The
check errs towards "on track" on purpose — a missed patch of grass is a
nuisance, a reset in the middle of the road ruins a round.

A consequence worth knowing: this confines hiders to the track. On a map where
the terrain itself is meant to be driven, turn the setting off.

## Known limitations

- Catches are judged from the host's view of the world, so a hider on a
  high-ping connection is judged where the host last saw them. This is
  consistent for everybody, but it is not the hider's own view.
- Catches are distance-based (default 2.1 world units, roughly a car length),
  not true collisions — remote cars in PolyTrack are render-only and have no
  physics body, so there is nothing to collide with.
- The round runs only while the host is on the track. If the host quits to the
  menu, the round ends.
- Tracks with a short lap are poor arenas; hiders run out of places to go.
