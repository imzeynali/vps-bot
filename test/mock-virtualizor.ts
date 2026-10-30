import http from "node:http";

/** پنل شبیه‌ساز Virtualizor (فقط برای تست؛ ساختار پاسخ‌ها بر اساس مستندات) */
export interface Mock {
  port: number;
  vps: Map<number, any>;
  calls: { act: string; query: Record<string, string>; body: Record<string, string> }[];
  failNext: { act: string; mode: "panel" | "hang" } | null;
  close(): Promise<void>;
}

export async function startMock(): Promise<Mock> {
  const vps = new Map<number, any>();
  let nextId = 100;
  let nextIp = 10;
  const m: Mock = { port: 0, vps, calls: [], failNext: null, close: async () => {} };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const u = new URL(req.url!, "http://x");
      const q = Object.fromEntries(u.searchParams);
      const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      const send = (o: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(o));
      };
      if (q.adminapikey !== "KEY" || q.adminapipass !== "PASS") return send({ error: ["Invalid API credentials"] });
      m.calls.push({ act: q.act, query: q, body });

      if (m.failNext && m.failNext.act === q.act) {
        const f = m.failNext;
        m.failNext = null;
        if (f.mode === "hang") return; // timeout
        return send({ error: { msg: "No free IPs in the pool" } });
      }

      switch (q.act) {
        case "adminindex":
          return send({ title: "Dashboard" });
        case "servers":
          return send({ servers: { 0: { serid: "0", server_name: "localhost", virt: "kvm" }, 1: { serid: "1", server_name: "node-teh", virt: "kvm" } } });
        case "ostemplates":
          return send({ oslist: { kvm: { 1: { osid: "11", name: "ubuntu-22.04-x86_64", type: "kvm" }, 2: { osid: "12", name: "debian-12-x86_64", type: "kvm" } } } });
        case "plans":
          return send({ plans: { 5: { plid: "5", plan_name: "Basic", virt: "kvm", ram: "2048", cores: "2", space: "40" }, 6: { plid: "6", plan_name: "OpenVZ-only", virt: "openvz", ram: "512", cores: "1", space: "10" } } });
        case "ippool":
          return send({ ippools: { 3: { ippid: "3", ip_pool_name: "Teh-Pool" } } });
        case "addvs": {
          if (body.user_email !== "bot@example.com" || !body.rootpass || !body.hostname) return send({ error: { user: "bad params" } });
          const id = nextId++;
          vps.set(id, { vpsid: String(id), hostname: body.hostname, serid: body.serid, osid: body.osid, ram: body.ram, cores: body.cores, space: body.space, ips: { 1: `10.0.0.${nextIp++}` }, state: "on" });
          return send({ title: "Add Virtual Server", done: { msg: "VPS created", vpsid: id }, vpsinfo: { vpsid: id } });
        }
        case "vs": {
          if (q.delete) {
            if (!vps.delete(Number(q.delete))) return send({ error: ["VPS does not exist"] });
            return send({ done: true, done_msg: "deleted" });
          }
          if (q.action) {
            const v = vps.get(Number(q.vpsid));
            if (!v) return send({ error: ["VPS does not exist"] });
            v.state = q.action === "start" || q.action === "restart" ? "on" : "off";
            v.lastAction = q.action;
            return send({ title: "Virtual Servers", done: true, done_msg: "ok" });
          }
          // لیست با فیلتر
          const out: Record<string, any> = {};
          for (const [id, v] of vps) {
            if (q.vpsid && String(id) !== q.vpsid) continue;
            if (q.vpshostname && v.hostname !== q.vpshostname) continue;
            out[id] = v;
          }
          return send({ title: "Virtual Servers", vs: out });
        }
        case "rebuild": {
          const v = vps.get(Number(body.vpsid));
          if (!v) return send({ error: ["VPS does not exist"] });
          if (body.newpass !== body.conf || body.reos !== "1") return send({ error: ["bad rebuild params"] });
          v.osid = body.osid;
          v.rebuiltPass = body.newpass;
          return send({ title: "Rebuild Virtual Server", done: { msg: "rebuild started" } });
        }
      }
      send({ error: ["unknown act " + q.act] });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  m.port = (server.address() as any).port;
  m.close = () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r())));
  return m;
}
