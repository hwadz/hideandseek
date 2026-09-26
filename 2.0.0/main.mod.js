/* =====================================================================
 *  Hide & Seek  —  a multiplayer gamemode for PolyTrack 0.6.3
 *  Built for PolyModLoader 0.6.3.
 *
 *  One player (or several, on big lobbies) is the seeker. The seeker
 *  stares at a black screen while the hiders scatter; when the timer
 *  runs out the seeker is released and has to drive into the hiders.
 *
 *    Hide & Seek  - a caught hider is eliminated, last hider standing wins
 *    Infection    - a caught hider joins the seekers
 *    Tag          - the caught player becomes the new (only) seeker
 *
 *  Skid marks and name tags are switched off for the whole lobby while
 *  a round is running, because both of them give hiders away.
 *
 *  The HOST is authoritative: it already receives every car update from
 *  every client, so it alone decides roles, timers and catches and then
 *  broadcasts the round state. Clients only render it. Nothing is ever
 *  sent from a client to the host, and the host only ever sends to
 *  peers that advertised this mod during the join handshake - a vanilla
 *  client that received an unknown message would drop the connection.
 * ===================================================================== */

import {
  PolyMod,
  MixinType,
  SettingType,
} from "https://cdn.polymodloader.com/pml/PolyModLoader/0.6.3/PolyTypes.js";

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

const MOD_ID = "hideandseek";
const MOD_VERSION = "2.0.0";

/* Wire format: "HNS" + protocol version, then UTF-8 JSON. */
const MAGIC = [0x48, 0x4e, 0x53, 0x01];

const BROADCAST_INTERVAL = 0.2; /* s between host state broadcasts       */
const MIN_PLAYERS = 2; /* players (with the mod) needed to start         */
const VERTICAL_TAG_LIMIT = 1.6; /* world units, stops catches through floors */
const RESPAWN_IMMUNITY = 1.5; /* s of safety after a respawn             */
const NO_TAGBACK = 5.0; /* s, tag mode only                              */
const OVER_SECONDS = 8; /* s the winner screen stays up                  */
const RADAR_INTERVAL = 10; /* s between late-round seeker pings          */
const RADAR_FROM = 1 / 3; /* radar wakes up with this fraction left      */
const FEED_LENGTH = 6;

/* The car is roughly 1.44 x 2.9 world units (the game's detectorBoxSize
 * is 0.89 x 0.22 x 1.8 and the wheels sit at +-0.72 / +-1.53), so two
 * cars that are actually touching are 1.5 - 2.9 apart centre to centre. */
const TAG_DISTANCE = { tight: 1.6, normal: 2.1, generous: 2.7 };

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

const now = () => performance.now() / 1000;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return m + ":" + String(s % 60).padStart(2, "0");
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = array[i];
    array[i] = array[j];
    array[j] = swap;
  }
  return array;
}

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/* A couple of synthesised blips. The game's own sound bank goes through
 * the resource tracker, which throws if anything is added after the
 * loading screen is gone, so the mod brings its own oscillator. */
const Blip = {
  ctx: null,
  volume: 1,
  play(tones, length, gain) {
    if (this.volume <= 0) return;
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
      }
      const ctx = this.ctx;
      if (ctx.state === "suspended") ctx.resume();
      let at = ctx.currentTime;
      for (const frequency of tones) {
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = frequency;
        amp.gain.setValueAtTime(0.0001, at);
        amp.gain.linearRampToValueAtTime(gain * this.volume, at + 0.008);
        amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
        osc.connect(amp);
        amp.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + length + 0.02);
        at += length;
      }
    } catch (err) {
      /* audio is a nicety, never let it break the round */
    }
  },
  caught() {
    this.play([740, 420], 0.12, 0.25);
  },
  released() {
    this.play([330, 440, 660], 0.13, 0.25);
  },
  tick() {
    this.play([880], 0.05, 0.12);
  },
  win() {
    this.play([523, 659, 784, 1046], 0.13, 0.25);
  },
  radar() {
    this.play([1200], 0.04, 0.1);
  },
};

/* ------------------------------------------------------------------ *
 *  HUD
 * ------------------------------------------------------------------ */

const CSS = `
.hns-root, .hns-root * { box-sizing: border-box; }
.hns-root {
  position: fixed; inset: 0; pointer-events: none;
  font-family: ForcedSquare, Arial, sans-serif;
  color: #fff; z-index: 2147482000;
  text-shadow: 0 2px 4px rgba(0,0,0,0.85);
  --hns-seek: #ff5a4b;
  --hns-hide: #57d9a3;
  --hns-out:  #9aa3b2;
}
.hns-root.hns-off { display: none; }

.hns-top {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.hns-role {
  font-size: 26px; letter-spacing: 3px; padding: 2px 16px;
  border-radius: 4px; background: rgba(0,0,0,0.45);
}
.hns-role.seeker { color: var(--hns-seek); }
.hns-role.hider  { color: var(--hns-hide); }
.hns-role.out    { color: var(--hns-out); }
.hns-timer { font-size: 40px; line-height: 1; letter-spacing: 2px; }
.hns-timer.urgent { color: var(--hns-seek); }
.hns-phase { font-size: 15px; opacity: 0.8; letter-spacing: 2px; }

.hns-players {
  position: absolute; top: 12px; left: 12px;
  background: rgba(0,0,0,0.42); border-radius: 4px; padding: 8px 12px;
  min-width: 170px; font-size: 16px; line-height: 1.5;
}
.hns-players .hns-head {
  font-size: 13px; opacity: 0.65; letter-spacing: 2px; margin-bottom: 4px;
}
.hns-players .row { display: flex; justify-content: space-between; gap: 14px; }
.hns-players .row.seeker { color: var(--hns-seek); }
.hns-players .row.hider  { color: var(--hns-hide); }
.hns-players .row.out    { color: var(--hns-out); text-decoration: line-through; opacity: 0.7; }
.hns-players .row .tag { font-size: 12px; opacity: 0.75; }

.hns-feed {
  position: absolute; bottom: 90px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  font-size: 17px;
}
.hns-feed div { background: rgba(0,0,0,0.38); padding: 1px 10px; border-radius: 3px; }

.hns-banner {
  position: absolute; top: 34%; left: 50%; transform: translateX(-50%);
  font-size: 54px; letter-spacing: 4px; text-align: center;
  opacity: 0; transition: opacity 0.25s ease; white-space: nowrap;
}
.hns-banner.show { opacity: 1; }
.hns-banner .sub { display: block; font-size: 20px; letter-spacing: 2px; opacity: 0.85; }

.hns-hint {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
  font-size: 16px; opacity: 0.8; background: rgba(0,0,0,0.4);
  padding: 3px 12px; border-radius: 3px; text-align: center;
}

.hns-radar {
  position: absolute; bottom: 130px; left: 50%; transform: translateX(-50%);
  font-size: 20px; background: rgba(0,0,0,0.45); padding: 3px 14px;
  border-radius: 3px; letter-spacing: 2px;
}

/* Red creep around the edges when a seeker is close. */
.hns-warn {
  position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse at center,
      rgba(255,40,30,0) 45%, rgba(255,40,30,0.55) 100%);
  transition: opacity 0.12s linear;
}

/* The seeker's blindfold. Sits above everything else the mod draws. */
.hns-blind {
  position: fixed; inset: 0; background: #000; z-index: 2147483000;
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; pointer-events: none;
  font-family: ForcedSquare, Arial, sans-serif; color: #fff;
}
.hns-blind .label { font-size: 22px; letter-spacing: 6px; opacity: 0.55; }
.hns-blind .count { font-size: 120px; line-height: 1; letter-spacing: 6px; }
.hns-blind .note  { font-size: 16px; opacity: 0.4; letter-spacing: 2px; }

/* The personal-best popup would happily announce a hider who drove
 * over the finish line, so it is hidden for the duration. */
.hns-hide-finish .time-announcer-ui { display: none !important; }
`;

class Hud {
  constructor() {
    this.built = false;
    this.bannerUntil = 0;
  }

  build() {
    if (this.built) return;
    this.built = true;

    const style = document.createElement("style");
    style.id = "hns-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.className = "hns-root hns-off";
    root.innerHTML =
      '<div class="hns-warn"></div>' +
      '<div class="hns-players"><div class="hns-head">PLAYERS</div><div class="list"></div></div>' +
      '<div class="hns-top">' +
      '<div class="hns-role"></div>' +
      '<div class="hns-timer"></div>' +
      '<div class="hns-phase"></div>' +
      "</div>" +
      '<div class="hns-radar" style="display:none"></div>' +
      '<div class="hns-feed"></div>' +
      '<div class="hns-banner"></div>' +
      '<div class="hns-hint"></div>';
    document.body.appendChild(root);

    const blind = document.createElement("div");
    blind.className = "hns-blind";
    blind.style.display = "none";
    blind.innerHTML =
      '<div class="label">YOU ARE THE SEEKER</div>' +
      '<div class="count">30</div>' +
      '<div class="note">sit tight - the hiders are scattering</div>';
    document.body.appendChild(blind);

    this.root = root;
    this.blind = blind;
    this.el = {
      warn: root.querySelector(".hns-warn"),
      list: root.querySelector(".hns-players .list"),
      players: root.querySelector(".hns-players"),
      role: root.querySelector(".hns-role"),
      timer: root.querySelector(".hns-timer"),
      phase: root.querySelector(".hns-phase"),
      radar: root.querySelector(".hns-radar"),
      feed: root.querySelector(".hns-feed"),
      banner: root.querySelector(".hns-banner"),
      hint: root.querySelector(".hns-hint"),
      count: blind.querySelector(".count"),
    };
  }

  /* Deliberately does not touch the blindfold: hiding the HUD must
   * never be a way for a seeker to see the track early. */
  setVisible(visible) {
    this.build();
    this.root.classList.toggle("hns-off", !visible);
  }

  setBlind(visible, remaining) {
    this.build();
    this.blind.style.display = visible ? "flex" : "none";
    if (visible) {
      this.el.count.textContent = String(Math.max(0, Math.ceil(remaining)));
    }
  }

  setWarning(intensity) {
    this.build();
    this.el.warn.style.opacity = String(clamp(intensity, 0, 1) * 0.9);
  }

  banner(text, sub, seconds) {
    this.build();
    this.el.banner.innerHTML =
      escapeHtml(text) +
      (sub ? '<span class="sub">' + escapeHtml(sub) + "</span>" : "");
    this.el.banner.classList.add("show");
    this.bannerUntil = now() + (seconds || 2.5);
  }

  render(view) {
    this.build();
    const el = this.el;

    el.role.textContent = view.roleText;
    el.role.className = "hns-role " + view.roleClass;
    el.timer.textContent = view.timerText;
    el.timer.className = "hns-timer" + (view.urgent ? " urgent" : "");
    el.phase.textContent = view.phaseText;
    el.hint.textContent = view.hint || "";
    el.hint.style.display = view.hint ? "" : "none";

    if (view.radar) {
      el.radar.style.display = "";
      el.radar.textContent = view.radar;
    } else {
      el.radar.style.display = "none";
    }

    el.players.style.display = view.rows ? "" : "none";
    if (view.rows) {
      el.list.innerHTML = view.rows
        .map(
          (r) =>
            '<div class="row ' +
            r.cls +
            '"><span>' +
            escapeHtml(r.name) +
            '</span><span class="tag">' +
            escapeHtml(r.tag) +
            "</span></div>",
        )
        .join("");
    }

    el.feed.innerHTML = view.feed
      .map((line) => "<div>" + escapeHtml(line) + "</div>")
      .join("");

    if (now() > this.bannerUntil) el.banner.classList.remove("show");
  }
}

/* ------------------------------------------------------------------ *
 *  Runtime
 * ------------------------------------------------------------------ */

const HNS = {
  pml: null,
  hud: new Hud(),

  /* Flags read from injected bundle code on hot paths - plain
   * properties so the lookup stays a single property read. */
  f_noSkid: false,
  f_active: false,

  /* Current multiplayer session, or null when not in one. */
  sess: null,

  /* The round: authoritative on the host, mirrored on clients. */
  state: null,

  /* Host-only bookkeeping that never goes over the wire. */
  host: null,

  lastFeedKey: 0,
  lastRender: now(),
  lastTickSeen: 0,
  lastProximityPing: 0,
  lastRadarPing: 0,
  localOpacity: 1,

  /* ---------------- gamemode picked on the host screen ------------- */

  /* Which gamemode the host chose in the Game Mode row, or null for
   * plain racing. Written by the injected UI code. */
  hostMode: null,
  pendingAutoStart: false,
  lastAutoStartTry: 0,

  /* The buttons the mod adds next to Casual and Competitive.
   *
   * These deliberately do NOT become new values of the game's own game
   * mode enum. A value the enum does not know makes every client bail
   * out of the NewSession message with "Unknown gameMode value" and
   * hang up, and two other places throw "Unknown multiplayer game
   * mode" outright. So the session still runs as Casual on the wire
   * and the real mode travels over the mod's own channel. */
  gamemodes() {
    return [
      {
        id: "hns",
        title: "Hide & Seek",
        info: "One seeker is blindfolded while the hiders scatter. A caught hider is out; the last one standing wins.",
      },
      {
        id: "infection",
        title: "Infection",
        info: "A caught hider joins the seekers. The seekers win by catching everyone before the clock runs out.",
      },
      {
        id: "tag",
        title: "Tag",
        info: "Whoever gets caught becomes IT. Least time spent as IT when the clock runs out wins.",
      },
    ];
  },

  /* ---------------- settings ---------------- */

  /* pml.getSetting() reaches into the bundle through eval(), so the
   * answers are cached for a moment rather than re-read several times
   * per frame. */
  settingCache: new Map(),

  setting(id, fallback) {
    const t = now();
    const hit = this.settingCache.get(id);
    if (hit && t - hit.at < 0.5) return hit.value;
    let value;
    try {
      value = this.pml.getSetting(id);
    } catch (err) {
      value = undefined;
    }
    if (value === undefined || value === null) value = fallback;
    this.settingCache.set(id, { at: t, value });
    return value;
  },

  bool(id, fallback) {
    return this.setting(id, fallback ? "true" : "false") === "true";
  },

  number(id, fallback) {
    const value = parseFloat(this.setting(id, String(fallback)));
    return Number.isFinite(value) ? value : fallback;
  },

  /* ---------------- session plumbing ---------------- */

  enterSession(conn, sessionId) {
    this.leaveSession();
    this.sess = {
      conn,
      sessionId,
      /* hnsSend only exists on the host connection class. */
      isHost: typeof conn.hnsSend === "function",
      myId: null,
      players: [],
      playersAt: -1,
      localCar: null,
      remote: null,
    };
    if (this.sess.isHost) this.resetHostBookkeeping();
    /* Hosting with one of the mod's gamemodes selected starts a round
     * by itself, as soon as enough players have actually joined. */
    this.pendingAutoStart = this.sess.isHost && !!this.hostMode;
    console.log(
      "[hideandseek] session " +
        sessionId +
        (this.sess.isHost ? " (host)" : " (client)") +
        (this.hostMode ? " mode=" + this.hostMode : ""),
    );
  },

  resetHostBookkeeping(keepPrevious) {
    const previous = keepPrevious && this.host ? this.host.previousSeekers : [];
    const seq = this.host ? this.host.seq : 0;
    this.host = {
      last: now(),
      nextBroadcast: 0,
      nextReconcile: 1,
      seq,
      cooldown: {},
      immunity: {},
      tagBack: {},
      frames: {},
      seekerTime: {},
      previousSeekers: previous,
    };
  },

  leaveSession() {
    if (this.sess) this.clearLocalEffects();
    this.sess = null;
    this.state = null;
    this.host = null;
    this.f_active = false;
    this.f_noSkid = false;
    this.lastFeedKey = 0;
    document.documentElement.classList.remove("hns-hide-finish");
    this.hud.setVisible(false);
  },

  onSessionEnd() {
    this.leaveSession();
  },

  /* getPlayers() clones every record, so it is cached for a moment
   * rather than called once per frame. */
  players() {
    const s = this.sess;
    if (!s) return [];
    const t = now();
    if (t - s.playersAt < 0.5) return s.players;
    try {
      s.players = s.conn.getPlayers() || [];
    } catch (err) {
      s.players = [];
    }
    s.playersAt = t;
    const self = s.players.find((p) => p.isSelf);
    if (self) s.myId = self.id;
    return s.players;
  },

  nameOf(id) {
    const player = this.players().find((p) => p.id === id);
    return player && player.nickname ? player.nickname : "Player " + id;
  },

  /* Everybody in the lobby running this mod, us included. Only these
   * can take part; a vanilla peer never receives the broadcast. */
  moddedIds() {
    const s = this.sess;
    if (!s || !s.isHost) return [];
    let ids;
    try {
      ids = s.conn.hnsModdedIds() || [];
    } catch (err) {
      ids = [];
    }
    if (s.myId !== null && ids.indexOf(s.myId) === -1) ids.push(s.myId);
    return ids;
  },

  /* ---------------- transport ---------------- */

  broadcast(payload) {
    const s = this.sess;
    if (!s || !s.isHost) return;
    const body = new TextEncoder().encode(JSON.stringify(payload || this.state));
    const bytes = new Uint8Array(MAGIC.length + body.length);
    bytes.set(MAGIC, 0);
    bytes.set(body, MAGIC.length);
    try {
      s.conn.hnsSend(bytes);
    } catch (err) {
      console.error("[hideandseek] broadcast failed", err);
    }
  },

  onClientMessage(conn, payload) {
    if (payload.length < MAGIC.length) return;
    for (let i = 0; i < MAGIC.length; i++) {
      if (payload[i] !== MAGIC[i]) return; /* another mod's message */
    }
    let incoming;
    try {
      incoming = JSON.parse(
        new TextDecoder().decode(payload.subarray(MAGIC.length)),
      );
    } catch (err) {
      return;
    }
    if (!incoming || incoming.phase === "idle") {
      this.state = null;
      this.lastFeedKey = 0;
      this.clearLocalEffects();
    } else {
      this.state = incoming;
    }
  },

  onHostMessage() {
    /* Clients never talk to the host in this protocol. The hook is
     * still registered so a stray payload is consumed instead of
     * tripping the "leftover data" check and killing the peer. */
  },

  /* ---------------- round control (host) ---------------- */

  toggleRound() {
    if (!this.sess) return;
    if (!this.sess.isHost) {
      this.hud.banner("Host only", "Only the lobby host starts a round", 2.5);
      return;
    }
    /* Whichever way the host drives it by hand, stop the pending
     * auto-start from firing a second round underneath them. */
    this.pendingAutoStart = false;
    if (this.state) this.abortRound();
    else this.startRound();
  },

  startRound() {
    const eligible = this.moddedIds();
    const missing = this.players().length - eligible.length;

    if (eligible.length < MIN_PLAYERS) {
      this.hud.banner(
        "Not enough players",
        "Needs " + MIN_PLAYERS + " players running the mod",
        3,
      );
      return;
    }

    /* A gamemode chosen on the Host Multiplayer screen wins over the
     * one in the settings menu, which is the default for the keybind. */
    const mode = this.hostMode || this.setting("HnsMode", "hns");
    const hideTime = this.number("HnsHideTime", 30);
    const roundTime = this.number("HnsRoundTime", 300);

    /* Seeker count. Tag always has exactly one. */
    let seekers = 1;
    if (mode !== "tag") {
      const configured = this.setting("HnsSeekers", "auto");
      seekers =
        configured === "auto"
          ? clamp(Math.round(eligible.length / 5), 1, 3)
          : parseInt(configured, 10) || 1;
      seekers = clamp(seekers, 1, eligible.length - 1);
    }

    /* Prefer players who did not seek last round. */
    const previous = this.host ? this.host.previousSeekers : [];
    const fresh = shuffle(eligible.filter((id) => previous.indexOf(id) === -1));
    const repeat = shuffle(eligible.filter((id) => previous.indexOf(id) !== -1));
    const chosen = fresh.concat(repeat).slice(0, seekers);

    this.resetHostBookkeeping();
    this.host.previousSeekers = chosen.slice();
    for (const id of eligible) this.host.seekerTime[id] = 0;

    const names = {};
    for (const id of eligible) names[id] = this.nameOf(id);

    this.state = {
      v: 1,
      mode,
      phase: "hiding",
      hide: hideTime,
      round: roundTime,
      over: 0,
      play: eligible.slice(),
      seek: chosen,
      out: [],
      /* How many hiders the round started with. "Last hider standing"
       * only ends a round that had more than one hider to begin with,
       * otherwise a 1-v-1 would be over before it started. */
      hid0: eligible.length - chosen.length,
      names,
      score: {},
      feed: [],
      win: null,
      warn: this.number("HnsWarnRadius", 14),
      tagDistance:
        TAG_DISTANCE[this.setting("HnsTagDistance", "normal")] ||
        TAG_DISTANCE.normal,
    };

    this.say(
      chosen.map((id) => names[id]).join(", ") +
        (chosen.length > 1 ? " are seeking" : " is seeking"),
    );
    if (missing > 0) {
      this.say(missing + " player(s) without the mod are spectating");
    }
    this.broadcast();
  },

  abortRound() {
    if (!this.state) return;
    this.finish("Round cancelled by the host");
  },

  finish(winText) {
    this.state.phase = "over";
    this.state.over = OVER_SECONDS;
    this.state.win = winText;
    this.say(winText);
    this.broadcast();
  },

  clearRound() {
    this.broadcast({ v: 1, phase: "idle" });
    this.state = null;
    this.lastFeedKey = 0;
    this.clearLocalEffects();
  },

  say(text) {
    if (!this.state || !this.host) return;
    this.host.seq += 1;
    this.state.feed.push({ k: this.host.seq, m: text });
    while (this.state.feed.length > FEED_LENGTH) this.state.feed.shift();
  },

  /* ---------------- host simulation ---------------- */

  hostTick(positions) {
    const state = this.state;
    const host = this.host;
    const t = now();
    const dt = clamp(t - host.last, 0, 0.5);
    host.last = t;

    if (state.phase !== "over") {
      host.nextReconcile -= dt;
      if (host.nextReconcile <= 0) {
        host.nextReconcile = 1;
        this.reconcilePlayers();
        if (!this.state || this.state.phase === "over") return;
      }
    }

    if (state.phase === "hiding") {
      state.hide -= dt;
      if (state.hide <= 0) {
        state.hide = 0;
        state.phase = "seeking";
        this.say("The seeker is loose");
        this.broadcast();
      }
    } else if (state.phase === "seeking") {
      state.round -= dt;
      for (const id of state.seek) {
        host.seekerTime[id] = (host.seekerTime[id] || 0) + dt;
      }
      this.detectRespawns(positions, t);
      this.detectCatches(positions, t);
      if (state.phase === "seeking") this.checkWin();
      if (state.phase === "seeking" && state.round <= 0) {
        state.round = 0;
        this.onTimeUp();
      }
    } else if (state.phase === "over") {
      state.over -= dt;
      if (state.over <= 0) {
        const again = this.bool("HnsAutoRestart", true);
        this.clearRound();
        if (again) this.startRound();
        return;
      }
    }

    if (!this.state) return;
    this.state.score = host.seekerTime;
    host.nextBroadcast -= dt;
    if (host.nextBroadcast <= 0) {
      host.nextBroadcast = BROADCAST_INTERVAL;
      this.broadcast();
    }
  },

  /* A respawn resets the car's frame counter. Whoever just came back
   * gets a moment of safety so a seeker cannot camp the start line. */
  detectRespawns(positions, t) {
    const host = this.host;
    for (const entry of positions) {
      const id = entry[0];
      const frames = entry[1].frames;
      if (host.frames[id] !== undefined && frames < host.frames[id]) {
        host.immunity[id] = t + RESPAWN_IMMUNITY;
      }
      host.frames[id] = frames;
    }
  },

  detectCatches(positions, t) {
    const state = this.state;
    const host = this.host;
    const radiusSq = state.tagDistance * state.tagDistance;

    for (const seeker of state.seek.slice()) {
      if ((host.cooldown[seeker] || 0) > t) continue;
      const from = positions.get(seeker);
      if (!from) continue;

      for (const victim of state.play) {
        if (victim === seeker) continue;
        if (state.seek.indexOf(victim) !== -1) continue;
        if (state.out.indexOf(victim) !== -1) continue;
        if ((host.immunity[victim] || 0) > t) continue;
        if (state.mode === "tag" && host.tagBack[seeker] === victim) continue;

        const to = positions.get(victim);
        if (!to) continue;
        if (Math.abs(from.y - to.y) > VERTICAL_TAG_LIMIT) continue;
        const dx = from.x - to.x;
        const dz = from.z - to.z;
        if (dx * dx + dz * dz > radiusSq) continue;

        this.applyCatch(seeker, victim, t);
        break; /* one catch per seeker per frame */
      }
    }
  },

  applyCatch(seeker, victim, t) {
    const state = this.state;
    const host = this.host;
    const cooldown = this.number("HnsTagCooldown", 3);
    const seekerName = state.names[seeker] || this.nameOf(seeker);
    const victimName = state.names[victim] || this.nameOf(victim);

    host.cooldown[seeker] = t + cooldown;

    if (state.mode === "tag") {
      /* The victim becomes the only seeker. The old one is free but
       * cannot be tagged straight back for a few seconds. */
      state.seek = [victim];
      host.cooldown[victim] = t + cooldown;
      host.immunity[seeker] = t + cooldown;
      host.tagBack[victim] = seeker;
      setTimeout(() => {
        if (this.host && this.host.tagBack[victim] === seeker) {
          delete this.host.tagBack[victim];
        }
      }, NO_TAGBACK * 1000);
      this.say(seekerName + " tagged " + victimName + " - " + victimName + " is IT");
    } else if (state.mode === "infection") {
      state.seek.push(victim);
      host.cooldown[victim] = t + cooldown;
      this.say(victimName + " was infected by " + seekerName);
    } else {
      state.out.push(victim);
      this.say(victimName + " was caught by " + seekerName);
    }
    this.broadcast();
  },

  hiderIds() {
    const state = this.state;
    return state.play.filter(
      (id) => state.seek.indexOf(id) === -1 && state.out.indexOf(id) === -1,
    );
  },

  checkWin() {
    const state = this.state;
    const hiders = this.hiderIds();

    if (state.mode === "hns") {
      if (hiders.length === 0) {
        this.finish("Seekers win - everyone was caught");
      } else if (hiders.length === 1 && state.hid0 > 1) {
        this.finish(
          (state.names[hiders[0]] || "?") + " wins - last hider standing",
        );
      }
    } else if (state.mode === "infection") {
      if (hiders.length === 0) {
        this.finish("Seekers win - everyone was infected");
      }
    }
    /* Tag has no early win; it is decided on the clock. */
  },

  onTimeUp() {
    const state = this.state;
    if (state.mode === "tag") {
      const scores = this.host.seekerTime;
      let best = null;
      for (const id of state.play) {
        if (best === null || (scores[id] || 0) < (scores[best] || 0)) best = id;
      }
      this.finish(
        (state.names[best] || "?") +
          " wins - least time as IT (" +
          formatClock(scores[best] || 0) +
          ")",
      );
      return;
    }

    const hiders = this.hiderIds();
    if (hiders.length === 0) this.finish("Seekers win");
    else if (hiders.length === 1) {
      this.finish(
        (state.names[hiders[0]] || "?") + " wins - survived to the end",
      );
    } else {
      this.finish("Hiders win - time ran out (" + hiders.length + " survived)");
    }
  },

  /* Somebody who quit mid-round must not keep a round alive forever,
   * and must not count towards "last hider standing" either. */
  reconcilePlayers() {
    const state = this.state;
    const present = this.moddedIds();
    const gone = state.play.filter((id) => present.indexOf(id) === -1);
    if (!gone.length) return;

    for (const id of gone) {
      const name = state.names[id] || this.nameOf(id);
      state.play = state.play.filter((p) => p !== id);
      state.seek = state.seek.filter((p) => p !== id);
      state.out = state.out.filter((p) => p !== id);
      if (state.hid0 > 0) state.hid0 -= 1;
      this.say(name + " left");
    }

    if (state.play.length < MIN_PLAYERS) {
      this.finish("Round abandoned - not enough players left");
      return;
    }
    if (state.seek.length === 0) {
      /* Every seeker disconnected: promote a random hider so the round
       * can still be won or lost instead of stalling. */
      const hiders = this.hiderIds();
      if (!hiders.length) {
        this.finish("Round abandoned - no seeker left");
        return;
      }
      const replacement = shuffle(hiders.slice())[0];
      state.seek = [replacement];
      state.hid0 = Math.max(1, state.hid0 - 1);
      this.say((state.names[replacement] || "?") + " is the new seeker");
    }
    this.broadcast();
  },

  /* ---------------- per frame ---------------- */

  /* Called from the game session's update(), handed the private fields
   * it keeps the local car, the remote cars and the session in. */
  tick(gameSession, dt, localCar, remoteCars, multiplayer) {
    this.lastTickSeen = now();

    if (!multiplayer || !multiplayer.multiplayerConnection) {
      if (this.sess) this.leaveSession();
      return;
    }

    const conn = multiplayer.multiplayerConnection;
    if (
      !this.sess ||
      this.sess.conn !== conn ||
      this.sess.sessionId !== multiplayer.sessionId
    ) {
      this.enterSession(conn, multiplayer.sessionId);
    }

    const s = this.sess;
    s.localCar = localCar;
    s.remote = remoteCars;
    this.players(); /* also refreshes myId */

    if (s.isHost && this.pendingAutoStart && !this.state) this.tryAutoStart();
    if (s.isHost && this.state) this.hostTick(this.collectPositions());

    this.applyLocalEffects();
  },

  /* Hosting with a mod gamemode selected waits for the lobby to fill
   * before kicking off, rather than failing on an empty session. Once
   * the first round is away, the "start another round automatically"
   * setting takes over. */
  tryAutoStart() {
    const t = now();
    if (t - this.lastAutoStartTry < 0.5) return;
    this.lastAutoStartTry = t;
    if (this.moddedIds().length < MIN_PLAYERS) return;
    this.pendingAutoStart = false;
    this.startRound();
  },

  /* id -> {x, y, z, frames} for everyone we can see. Remote cars are
   * render-only in PolyTrack (they carry no physics body), so catches
   * have to be distance based rather than collision based. */
  collectPositions() {
    const s = this.sess;
    const out = new Map();
    if (!s) return out;
    if (s.localCar && s.myId !== null) {
      const p = s.localCar.getPosition();
      out.set(s.myId, {
        x: p.x,
        y: p.y,
        z: p.z,
        frames: s.localCar.getCarState().frames,
      });
    }
    if (s.remote) {
      for (const entry of s.remote) {
        const id = entry[0];
        const record = entry[1];
        if (!record || !record.car) continue;
        const p = record.car.getPosition();
        out.set(id, {
          x: p.x,
          y: p.y,
          z: p.z,
          frames: record.car.getCarState().frames,
        });
      }
    }
    return out;
  },

  inList(list) {
    const s = this.sess;
    return !!(s && list && list.indexOf(s.myId) !== -1);
  },

  isSeeker() {
    return !!this.state && this.inList(this.state.seek);
  },

  isOut() {
    return !!this.state && this.inList(this.state.out);
  },

  isPlaying() {
    return !!this.state && this.inList(this.state.play);
  },

  clearLocalEffects() {
    const s = this.sess;
    this.f_active = false;
    this.f_noSkid = false;
    this.hud.setWarning(0);
    document.documentElement.classList.remove("hns-hide-finish");
    if (!s) return;
    if (s.localCar) {
      s.localCar.isControlsDisabled = false;
      s.localCar.isPaused = false;
      if (this.localOpacity !== 1) s.localCar.setOpacity(1);
    }
    this.localOpacity = 1;
    if (s.remote) {
      const players = this.players();
      for (const entry of s.remote) {
        const record = entry[1];
        if (!record || !record.car) continue;
        record.car.setOpacity(1);
        /* Hand the name tags back to the game. */
        const player = players.find((p) => p.id === entry[0]);
        if (player) record.car.setNameTag(player.countryCode, player.nickname);
      }
    }
  },

  applyLocalEffects() {
    const s = this.sess;
    const state = this.state;
    const running =
      !!state && (state.phase === "hiding" || state.phase === "seeking");

    /* Everything the mod overrides is restored the moment the round is
     * no longer running - including the winner screen, so the reveal
     * shows everybody's name again. */
    if (!running) {
      if (this.f_active) this.clearLocalEffects();
      return;
    }

    this.f_active = true;
    this.f_noSkid = this.bool("HnsHideSkidmarks", true);
    const hideTags = this.bool("HnsHideNameTags", true);
    document.documentElement.classList.add("hns-hide-finish");

    const blindfolded =
      state.phase === "hiding" && this.isSeeker() && this.isPlaying();

    /* --- our own car -------------------------------------------- */
    if (s.localCar) {
      s.localCar.isControlsDisabled = blindfolded;
      s.localCar.isPaused = blindfolded;
      if (blindfolded) s.localCar.audioVolume = 0;
      /* Cars that never started are stacked on the spawn and the game
       * hides all but one of them, so everyone is started explicitly
       * once the round is on. */
      if (running && !blindfolded && !s.localCar.hasStarted()) {
        try {
          s.localCar.start();
        } catch (err) {
          /* track not ready yet - try again next frame */
        }
      }
      /* setOpacity walks the whole car mesh, so only touch it on a
       * change. The game never does this to the local car itself. */
      const wanted = this.isOut() ? 0.35 : 1;
      if (this.localOpacity !== wanted) {
        this.localOpacity = wanted;
        s.localCar.setOpacity(wanted);
      }
    }

    /* --- everyone else's cars ----------------------------------- */
    if (s.remote) {
      for (const entry of s.remote) {
        const id = entry[0];
        const record = entry[1];
        if (!record || !record.car) continue;
        const car = record.car;
        if (hideTags) car.setNameTag(null, null);
        if (blindfolded) car.audioVolume = 0;
        if (state.out.indexOf(id) !== -1) {
          car.setOpacity(0.25);
          car.setVisible(true);
        }
      }
    }
  },

  /* ---------------- rendering ---------------- */

  render() {
    const t = now();
    const dt = clamp(t - this.lastRender, 0, 0.5);
    this.lastRender = t;

    const state = this.state;
    /* tick() stops being called outside a race, so a stale session is
     * treated as "no HUD" rather than freezing the old one on screen. */
    const live = this.sess && t - this.lastTickSeen < 1.5;

    if (!state || !state.play || !live) {
      this.hud.setVisible(false);
      this.hud.setBlind(false, 0);
      return;
    }

    /* Clients count down locally between broadcasts so the timer does
     * not step in 200 ms jumps. */
    if (!this.sess.isHost) {
      if (state.phase === "hiding") state.hide = Math.max(0, state.hide - dt);
      else if (state.phase === "seeking") {
        state.round = Math.max(0, state.round - dt);
      } else if (state.phase === "over") {
        state.over = Math.max(0, state.over - dt);
      }
    }

    const seeker = this.isSeeker();
    const out = this.isOut();
    const playing = this.isPlaying();
    const blindfolded = state.phase === "hiding" && seeker && playing;

    /* The blindfold is applied before the HUD toggle is consulted. */
    this.hud.setBlind(blindfolded, state.hide);

    if (!this.bool("HnsShowHud", true)) {
      this.hud.setVisible(false);
      this.hud.setWarning(0);
      return;
    }

    this.hud.setVisible(true);
    this.announceFeed();

    const view = {
      roleText: !playing
        ? "SPECTATOR"
        : out
          ? "CAUGHT"
          : seeker
            ? "SEEKER"
            : "HIDER",
      roleClass: !playing || out ? "out" : seeker ? "seeker" : "hider",
      timerText: "",
      phaseText: "",
      urgent: false,
      rows: null,
      feed: state.feed ? state.feed.map((f) => f.m) : [],
      hint: "",
      radar: null,
    };

    if (state.phase === "hiding") {
      view.timerText = formatClock(state.hide);
      view.phaseText = seeker
        ? "UNTIL YOU ARE RELEASED"
        : "UNTIL THE SEEKER IS RELEASED";
      view.urgent = state.hide <= 5;
    } else if (state.phase === "seeking") {
      view.timerText = formatClock(state.round);
      view.phaseText = { hns: "HIDE & SEEK", infection: "INFECTION", tag: "TAG" }[
        state.mode
      ];
      view.urgent = state.round <= 30;
    } else {
      view.phaseText = state.win || "ROUND OVER";
    }

    view.rows = state.play.map((id) => {
      const isSeek = state.seek.indexOf(id) !== -1;
      const isOut = state.out.indexOf(id) !== -1;
      return {
        name: (state.names && state.names[id]) || this.nameOf(id),
        cls: isOut ? "out" : isSeek ? "seeker" : "hider",
        tag: isOut ? "caught" : isSeek ? "seeker" : "hiding",
      };
    });

    if (this.sess.isHost) view.hint = "[N] stop the round";

    this.localSenses(view, state, seeker, out, playing, t);
    this.hud.render(view);
  },

  /* Proximity warning and the late-round radar are worked out on each
   * client from the car positions it already has, so they cost nothing
   * on the wire and stay smooth between broadcasts. */
  localSenses(view, state, seeker, out, playing, t) {
    if (state.phase !== "seeking" || !playing || out) {
      this.hud.setWarning(0);
      return;
    }

    const positions = this.collectPositions();
    const me = positions.get(this.sess.myId);
    if (!me) {
      this.hud.setWarning(0);
      return;
    }

    if (!seeker) {
      let closest = Infinity;
      for (const id of state.seek) {
        const p = positions.get(id);
        if (!p) continue;
        const dx = p.x - me.x;
        const dy = p.y - me.y;
        const dz = p.z - me.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < closest) closest = d;
      }
      const radius = state.warn || 14;
      const warn = this.bool("HnsProximityWarning", true) && closest < radius;
      this.hud.setWarning(warn ? 1 - closest / radius : 0);
      if (warn && closest < radius * 0.4 && t - this.lastProximityPing > 0.6) {
        this.lastProximityPing = t;
        this.tuneBlip();
        Blip.tick();
      }
      return;
    }

    this.hud.setWarning(0);
    if (!this.bool("HnsSeekerRadar", true)) return;

    /* Only in the closing stretch, so hiders are not handed over the
     * moment the round starts. */
    const total = this.number("HnsRoundTime", 300);
    if (state.round > total * RADAR_FROM) return;

    let best = null;
    let bestDistance = Infinity;
    for (const id of state.play) {
      if (state.seek.indexOf(id) !== -1) continue;
      if (state.out.indexOf(id) !== -1) continue;
      const p = positions.get(id);
      if (!p) continue;
      const dx = p.x - me.x;
      const dz = p.z - me.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { dx, dz };
      }
    }
    if (!best) return;

    const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    /* +x is east and +z is south in the scene. */
    const angle = Math.atan2(best.dx, -best.dz);
    const index = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    view.radar =
      "NEAREST HIDER  " + compass[index] + "  " + Math.round(bestDistance) + "m";

    if (t - this.lastRadarPing > RADAR_INTERVAL) {
      this.lastRadarPing = t;
      this.tuneBlip();
      Blip.radar();
    }
  },

  tuneBlip() {
    Blip.volume = this.bool("HnsSounds", true)
      ? clamp(this.number("SoundEffectVolume", 1), 0, 1)
      : 0;
  },

  announceFeed() {
    const state = this.state;
    if (!state || !state.feed || !state.feed.length) return;
    const newest = state.feed[state.feed.length - 1];
    if (newest.k <= this.lastFeedKey) return;

    const firstSync = this.lastFeedKey === 0;
    this.lastFeedKey = newest.k;
    if (firstSync) return; /* do not replay the backlog on join */

    this.tuneBlip();

    if (state.phase === "over") {
      this.hud.banner(state.win || "ROUND OVER", "", OVER_SECONDS);
      Blip.win();
      return;
    }

    if (newest.m.indexOf("seeker is loose") !== -1) {
      this.hud.banner("GO!", "The seeker has been released", 2.5);
      Blip.released();
      return;
    }

    if (/caught|infected|tagged/.test(newest.m)) {
      const myName = (state.names && state.names[this.sess.myId]) || "\u0000";
      const aboutMe = newest.m.indexOf(myName) === 0;
      this.hud.banner(
        aboutMe ? "CAUGHT!" : newest.m,
        aboutMe ? "free roam to spectate" : "",
        aboutMe ? 3.5 : 2,
      );
      Blip.caught();
    }
  },
};

/* The patched bundle only ever sees this object. */
window.PolyHNS = HNS;

/* ------------------------------------------------------------------ *
 *  Mod
 * ------------------------------------------------------------------ */

class HideAndSeekMod extends PolyMod {
  /* Global mixins must be registered here: preInit is the only point
   * at which the game bundle has not been evaluated yet. */
  preInit = (pml) => {
    HNS.pml = pml;

    /* 1. Make setNameTag(x, null) actually REMOVE the tag. The stock
     *    method always stores an object, so passing null would rebuild
     *    the sprite with the text "null" instead of dropping it. */
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `setNameTag(e, t) {`,
      func: `
        if (null == t) {
          if (null != (0, l.gn)(this, ve, "f")) {
            ((0, l.GG)(this, ve, null, "f"),
              (0, l.gn)(this, D, "m", Fe).call(this));
          }
          return;
        }
      `,
    });

    /* 2. Skid marks are a painted trail straight to a hider. */
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `spawn(e, t, n, i) {`,
      func: `
        if (window.PolyHNS && window.PolyHNS.f_noSkid) {
          this.break();
          return;
        }
      `,
    });

    /* 3 + 4. PolyTrack reserves message id 255 on both peer channels
     *        for mods but leaves the case empty, which also means the
     *        payload is never consumed - so each handler has to push
     *        the read cursor to the end itself or the caller's
     *        "leftover data" check drops the connection. */
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `case en.ModCustomMessage:`,
      func: `
        try {
          window.PolyHNS && window.PolyHNS.onHostMessage(this, t, r.subarray(a));
        } catch (hnsErr) {
          console.error("[hideandseek]", hnsErr);
        }
        a = r.length;
      `,
    });
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `case nn.ModCustomMessage:`,
      func: `
        try {
          window.PolyHNS && window.PolyHNS.onClientMessage(this, i.subarray(r));
        } catch (hnsErr) {
          console.error("[hideandseek]", hnsErr);
        }
        r = i.length;
      `,
    });

    /* 5. Give the host connection a broadcast helper. It deliberately
     *    skips peers that did not advertise the mod: a vanilla client
     *    treats an unknown payload as a protocol error and closes the
     *    connection on itself. */
    pml.registerGlobalMixin({
      type: MixinType.REPLACEBETWEEN,
      tokenStart: `kickPlayer(e) {`,
      tokenEnd: `kickPlayer(e) {`,
      func: `hnsSend(e) {
              const t = new Uint8Array(1 + e.length);
              ((t[0] = nn.ModCustomMessage), t.set(e, 1));
              for (const n of (0, R.gn)(this, _n, "f")) {
                if (!n.hnsMod) continue;
                try {
                  n.dataChannel.send(t);
                } catch (i) {
                  console.error("[hideandseek] send failed", i);
                }
              }
            }
            hnsModdedIds() {
              const e = [];
              for (const t of (0, R.gn)(this, _n, "f")) if (t.hnsMod) e.push(t.id);
              return e;
            }
            kickPlayer(e) {`,
    });

    /* 6. The per-frame hook, placed after the game has finished moving
     *    every car this frame: positions are current, and anything the
     *    mod writes is not overwritten again until the next frame. */
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `((0, R.gn)(this, ta, "m", Cs).call(this),`,
      func: `
                window.PolyHNS &&
                  window.PolyHNS.tick(
                    this,
                    n,
                    (0, R.gn)(this, Xa, "f"),
                    (0, R.gn)(this, as, "f"),
                    (0, R.gn)(this, Za, "f"),
                  ),`,
    });

    /* 7 + 8. Handshake, host side: remember per connected peer whether
     *        it runs this mod.
     *
     *        The signal is the join payload's own "mods" array, which
     *        PolyModLoader fills with "<modId>:<version>" for every
     *        loaded mod and which the host already validates as an
     *        array of strings. Nothing new is added to the JSON, so
     *        the handshake stays exactly what Kodub's signalling
     *        server and a vanilla host expect to see.
     *
     *        `var`, because by the time the peer record is built
     *        further down the same function both the parsed JSON and
     *        the mods array have been shadowed by local consts. */
    pml.registerGlobalMixin({
      type: MixinType.REPLACEBETWEEN,
      tokenStart: `for (const t of o.mods) {`,
      tokenEnd: `for (const t of o.mods) {`,
      func: `var hnsHasMod = !1;
                          for (const t of o.mods) {
                            if (
                              "string" == typeof t &&
                              0 === t.indexOf("${MOD_ID}:")
                            )
                              hnsHasMod = !0;`,
    });
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `isOfferSet: !1,`,
      func: `
                              hnsMod:
                                "undefined" != typeof hnsHasMod && !!hnsHasMod,`,
    });

    /* 9. Leaving the track tears the round down. */
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `dispose(e = !0, t = !0) {`,
      func: `
              try {
                window.PolyHNS && window.PolyHNS.onSessionEnd();
              } catch (hnsErr) {}
      `,
    });

    /* 10. Put the gamemodes where people actually look for them: the
     *     Game Mode row on the Host Multiplayer screen, next to Casual
     *     and Competitive.
     *
     *     Inserted just after the vanilla row is finished, where the
     *     container (a), the button list (o), the selected mode (r)
     *     and the description line (c) are all still in scope. The
     *     enclosing builder is a plain function called with .call(this),
     *     so an arrow function here still sees the right \`this\`.
     *
     *     Picking one of these leaves r on Casual - see gamemodes()
     *     for why the wire protocol must not learn a new value - and
     *     records the real mode for the session that is about to start. */
    pml.registerGlobalMixin({
      type: MixinType.INSERT,
      token: `((c.className = "info"), a.appendChild(c), l());`,
      func: `
              if (window.PolyHNS) {
                window.PolyHNS.hostMode = null;
                for (const e of o)
                  e.addEventListener("click", () => {
                    window.PolyHNS.hostMode = null;
                  });
                for (const hnsMode of window.PolyHNS.gamemodes()) {
                  const hnsButton = document.createElement("button");
                  ((hnsButton.className = "button"),
                    (hnsButton.textContent = hnsMode.title),
                    hnsButton.addEventListener("click", () => {
                      ((0, R.gn)(this, yc, "f").playUIClick(),
                        (r = an.Casual),
                        (window.PolyHNS.hostMode = hnsMode.id));
                      for (const e of o) e.classList.remove("selected");
                      (hnsButton.classList.add("selected"),
                        (c.textContent = hnsMode.info));
                    }),
                    a.appendChild(hnsButton),
                    o.push(hnsButton));
                }
              }`,
    });
  };

  init = (pml) => {
    HNS.pml = pml;

    pml.registerSettingCategory("Hide & Seek");

    pml.registerSetting("Gamemode", "HnsMode", SettingType.CUSTOM, "hns", [
      { title: "Hide & Seek", value: "hns" },
      { title: "Infection", value: "infection" },
      { title: "Tag", value: "tag" },
    ]);
    pml.registerSetting("Hiding time", "HnsHideTime", SettingType.CUSTOM, "30", [
      { title: "15 s", value: "15" },
      { title: "30 s", value: "30" },
      { title: "45 s", value: "45" },
      { title: "60 s", value: "60" },
      { title: "90 s", value: "90" },
    ]);
    pml.registerSetting(
      "Round length",
      "HnsRoundTime",
      SettingType.CUSTOM,
      "300",
      [
        { title: "3 min", value: "180" },
        { title: "5 min", value: "300" },
        { title: "8 min", value: "480" },
        { title: "12 min", value: "720" },
        { title: "20 min", value: "1200" },
      ],
    );
    pml.registerSetting("Seekers", "HnsSeekers", SettingType.CUSTOM, "auto", [
      { title: "Auto", value: "auto" },
      { title: "1", value: "1" },
      { title: "2", value: "2" },
      { title: "3", value: "3" },
    ]);
    pml.registerSetting(
      "Catch range",
      "HnsTagDistance",
      SettingType.CUSTOM,
      "normal",
      [
        { title: "Tight", value: "tight" },
        { title: "Normal", value: "normal" },
        { title: "Generous", value: "generous" },
      ],
    );
    pml.registerSetting(
      "Catch cooldown",
      "HnsTagCooldown",
      SettingType.CUSTOM,
      "3",
      [
        { title: "1 s", value: "1" },
        { title: "3 s", value: "3" },
        { title: "5 s", value: "5" },
      ],
    );
    pml.registerSetting(
      "Warning range",
      "HnsWarnRadius",
      SettingType.CUSTOM,
      "14",
      [
        { title: "Short", value: "8" },
        { title: "Normal", value: "14" },
        { title: "Long", value: "22" },
      ],
    );
    pml.registerSetting(
      "Start another round automatically",
      "HnsAutoRestart",
      SettingType.BOOL,
      true,
    );
    pml.registerSetting(
      "Hide name tags",
      "HnsHideNameTags",
      SettingType.BOOL,
      true,
    );
    pml.registerSetting(
      "Hide skid marks",
      "HnsHideSkidmarks",
      SettingType.BOOL,
      true,
    );
    pml.registerSetting(
      "Warn hiders when a seeker is close",
      "HnsProximityWarning",
      SettingType.BOOL,
      true,
    );
    pml.registerSetting(
      "Seeker radar late in the round",
      "HnsSeekerRadar",
      SettingType.BOOL,
      true,
    );
    pml.registerSetting("Sound cues", "HnsSounds", SettingType.BOOL, true);
    pml.registerSetting(
      "Show the Hide & Seek HUD",
      "HnsShowHud",
      SettingType.BOOL,
      true,
    );

    pml.registerBindCategory("Hide & Seek");
    pml.registerKeybind(
      "Start / stop round (host)",
      "HnsToggleRound",
      "keydown",
      "KeyN",
      null,
      (event) => {
        if (event.repeat || !HNS.sess) return;
        event.preventDefault();
        HNS.toggleRound();
      },
    );
  };

  postInit = () => {
    HNS.hud.build();
    const loop = () => {
      try {
        HNS.render();
      } catch (err) {
        console.error("[hideandseek] render", err);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    console.log("[hideandseek] " + MOD_ID + " " + MOD_VERSION + " ready");
  };

  onGameLoad = () => {};
}

export let polyMod = new HideAndSeekMod();
