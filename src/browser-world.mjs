import { chromium } from "playwright";
import { World } from "./world.mjs";

export class BrowserWorld extends World {
  async connect({ url, name, owner }) {
    const target = new URL(url);
    if (!["https:", "http:"].includes(target.protocol))
      throw new Error("Walking and perception require the HTTPS world URL.");
    target.searchParams.set("audio", "external");
    this.owner = owner?.toLowerCase() || null;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--enable-unsafe-swiftshader",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
    this.browser.on("disconnected", () => {
      if (!this.closing)
        this.emit("failure", new Error("World renderer disconnected"));
    });
    this.page = await this.browser.newPage({
      viewport: { width: 960, height: 640 },
      deviceScaleFactor: 1,
    });
    await this.page.addInitScript(
      ({ name }) => {
        localStorage.setItem("onboarding-complete", "1");
        localStorage.setItem(
          "prefs",
          JSON.stringify({
            v: 4,
            postprocessing: false,
            shadows: "none",
            dpr: 1,
            ui: 1,
          }),
        );
        const Base = window.WebSocket;
        window.WebSocket = class extends Base {
          constructor(raw, protocols) {
            const target = new URL(raw, location.href);
            if (target.pathname.endsWith("/ws"))
              target.searchParams.set("name", name);
            super(target.toString(), protocols);
          }
        };
      },
      { name },
    );
    await this.page.goto(target.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await this.page.waitForFunction(
      () => window.world?.entities?.player?.base && world.network.id,
      null,
      { timeout: 60000 },
    );
    const version = await this.page.evaluate(() => world.companions?.protocol);
    if (version !== 1)
      throw new Error(
        "This world needs the companion engine update. No owner authority was granted.",
      );
    await this.page.evaluate(() =>
      world.agentControl.enable({ headless: true }),
    );
    // Physics and app scripts load after the player snapshot. Wait for the
    // ground under our feet before accepting commands.
    await this.page.waitForFunction(
      () => {
        const player = world.entities.player;
        const point = player?.base?.position.toArray();
        const now = performance.now(),
          previous = window.__companionGround;
        const stable =
          point &&
          player.grounded &&
          previous &&
          Math.hypot(...point.map((n, i) => n - previous.point[i])) < 0.02;
        const since = stable ? previous.since : now;
        window.__companionGround = { point, since };
        return (
          stable &&
          now - since >= 200 &&
          [...world.entities.items.values()].every(
            (e) => e.data.type !== "app" || !e.building,
          )
        );
      },
      null,
      { timeout: 120000 },
    );
    await this.page.evaluate(() => {
      delete window.__companionGround;
      world.agentControl.enable();
      world.graphics.renderer.domElement.setAttribute("data-agent-view", "");
    });
    if (this.owner)
      await this.page.evaluate(
        (owner) => world.companions.request("register", { owner }),
        this.owner,
      );
    await this.refresh();
    this.timer = setInterval(() => {
      if (!this.refreshing)
        void this.refresh().catch((error) => {
          if (!this.closing) this.emit("failure", error);
        });
    }, 100);
  }
  async refresh() {
    this.refreshing = true;
    try {
      const state = await this.page.evaluate(() => ({
        connected: world.network.ws?.readyState === WebSocket.OPEN,
        id: world.network.id,
        instanceId:
          new URL(world.network.wsUrl).pathname.match(
            /\/instances\/([^/]+)/,
          )?.[1] || null,
        players: [...world.entities.players.values()].map((p) => ({
          id: p.data.id,
          name: p.data.name,
          position: p.base?.position.toArray() || p.data.position,
        })),
        livekit: world.livekit.opts
          ? { token: world.livekit.opts.token, wsUrl: world.livekit.opts.wsUrl }
          : null,
        levels: world.livekit.levels,
        muted: [...world.livekit.muted],
        voiceLevel: world.settings.voice,
        voiceRefDistance: world.settings.voiceRefDistance,
        voiceRolloffFactor: world.settings.voiceRolloffFactor,
        companion:
          world.companions.agents.find((a) => a.id === world.network.id) ||
          null,
        motion: world.agentControl.motion,
      }));
      if (!state.connected) throw new Error("World disconnected");
      const previous = this.companion;
      Object.assign(this, state, {
        players: new Map(state.players.map((p) => [p.id, p])),
        muted: new Set(state.muted),
      });
      if (
        previous?.generation !== state.companion?.generation ||
        previous?.ownerPlayerId !== state.companion?.ownerPlayerId
      )
        this.emit("pairing", state.companion);
      this.emit("update", { type: "state" });
    } finally {
      this.refreshing = false;
    }
  }
  // Recheck at execution time in the browser, not just in a cached polling snapshot.
  async act(method, value, authority = { type: "local" }) {
    return this.page.evaluate(
      ({ method, value, authority }) => {
        if (authority.type !== "local") {
          const binding = world.companions.agents.find(
            (a) => a.id === world.network.id,
          );
          if (
            authority.type !== "owner" ||
            !binding?.ownerPlayerId ||
            binding.ownerPlayerId !== authority.playerId ||
            binding.generation !== authority.generation
          )
            throw new Error("Verified owner required");
        }
        const methods = {
          walk: "walkTo",
          follow: "follow",
          face: "face",
          stop: "stop",
          interact: "interact",
        };
        if (method === "say") {
          if (typeof value !== "string" || !value.trim() || value.length > 1500)
            throw new Error("Chat text must be 1–1500 characters.");
          world.chat.send(value);
          return { sent: true };
        }
        if (!methods[method]) throw new Error("Unknown world action");
        return world.agentControl[methods[method]](value);
      },
      { method, value, authority },
    );
  }
  setPosition(position) {
    return this.act("walk", position);
  }
  say(text) {
    return this.act("say", text);
  }
  observe() {
    return this.page.evaluate(() => world.agentControl.observe());
  }
  async view() {
    await this.page.evaluate(() => world.graphics.render());
    const image = await this.page
      .locator("[data-agent-view]")
      .screenshot({ type: "jpeg", quality: 75, timeout: 15000 });
    return `data:image/jpeg;base64,${image.toString("base64")}`;
  }
  status() {
    return {
      ...super.status(),
      owner: this.owner,
      companion: this.companion,
      motion: this.motion,
      renderer: true,
    };
  }
  async close() {
    this.closing = true;
    this.connected = false;
    clearInterval(this.timer);
    await this.browser?.close();
  }
}
