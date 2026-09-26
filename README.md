# Hide & Seek — a multiplayer gamemode for PolyTrack 0.6.3

A PolyModLoader mod. One player is the seeker and sits behind a black screen
while everyone else scatters; when the timer runs out the seeker is released
and has to drive into the hiders.

It doubles as a tag gamemode — the same round machinery runs three rule sets.

| Mod version | PolyTrack / PolyModLoader |
| --- | --- |
| **1.1.0** (current) | 0.6.3 |
| 1.0.0 | 0.6.2 |

PolyModLoader picks the right one from `manifest.json` automatically — there is
a single import URL either way.

---

## Installing

Open PolyModLoader 0.6.3 (the launcher, or <https://w.polymodloader.com>), go to
**Mods → Add**, paste this URL, then press **Apply**:

```
https://cdn.polymodloader.com/gh/hwadz/hideandseek/main
```

That is PML's CDN form `…/[gh|cb|gl|bb]/<owner>/<repo>/<branch>[/path]` — `gh`
= GitHub, `cb` = Codeberg, `gl` = GitLab, `bb` = Bitbucket — pointed at
whichever folder holds `manifest.json`, which here is the repo root. If you
fork or move the repo, change the owner/repo/branch to match.

To iterate locally, serve this folder over HTTP, open <https://w.polymodloader.com>,
add `http://localhost:<port>` as a mod, and turn **cache mods** off in the PML
settings.

**Everyone in the lobby needs the mod.** The host only sends round state to
peers that advertised it during the join handshake, so a vanilla player simply
stays a spectator — they are never kicked and the lobby still works.

## Playing

1. Host a multiplayer game and wait for everyone to join.
2. The host presses **N** to start a round, **N** again to cancel one.
3. Round rules come from the **host's** Settings → Hide & Seek. Everyone
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
  body-block either.
- **The personal-best popup is suppressed** so a hider crossing the finish line
  does not get their screen taken over.
- **Disconnects are handled**: leavers drop out of the round, and if every
  seeker quits a hider is promoted rather than letting the round stall.

## Settings

Under **Settings → Hide & Seek**. Host-side (round rules): Gamemode, Hiding
time, Round length, Seekers, Catch range, Catch cooldown, Warning range, Start
another round automatically. Client-side (local preference): Hide name tags,
Hide skid marks, Warn hiders when a seeker is close, Seeker radar late in the
round, Sound cues, Show the Hide & Seek HUD.

Keybind under **Controls → Hide & Seek**: Start / stop round, default **N**.
(`H` was not available — PolyTrack already uses it for Toggle UI.)

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

### Mixins

Nine global mixins, all registered in `preInit` — see `1.1.0/main.mod.js`, each
one commented in place.

| # | Anchor | Why |
| --- | --- | --- |
| 1 | `setNameTag` | Teach it that a null name means *remove the tag*. Stock always stores an object, so the sprite would be rebuilt reading `"null"`. |
| 2 | Skid-mark `spawn` | Drop skid marks at the source while a round runs. |
| 3 | `case <c2h>.ModCustomMessage` | Host-side receive, and consume the payload. |
| 4 | `case <h2c>.ModCustomMessage` | Client-side receive, and consume the payload. |
| 5 | `kickPlayer` | Adds `hnsSend` / `hnsModdedIds` to the host connection class. |
| 6 | the opacity-pass call in `update()` | The per-frame hook, placed after every car has moved. |
| 7 | `for (const t of o.mods)` | Host-side: note whether a joining peer runs the mod. |
| 8 | `isOfferSet: !1,` | Store that flag on the peer record. |
| 9 | game session `dispose` | Tear the round down when the track is left. |

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

Both pass for 1.0.0/0.6.2 and 1.1.0/0.6.3. What they cannot cover is anything
that needs a real lobby: live WebRTC, the signalling server, and how the round
feels at real ping. Play-test before relying on it.

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
