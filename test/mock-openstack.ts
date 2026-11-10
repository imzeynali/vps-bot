import http from "node:http";

/**
 * شبیه‌ساز OpenStack (Keystone + Nova + Neutron) برای تست دیتاسنتر CGI.
 * رفتارهای مهم واقعی: پر شدن آی‌پی هر شبکه (۴۰۹ IpAddressGenerationFailure)، سرور async (BUILD→ACTIVE)،
 * حذف async، پورتِ متصل (۴۰۹ هنگام حذف)، ۴۰۹ برای start/stop تکراری، سهمیه، انقضای توکن (۴۰۱).
 */
export interface MockOS {
  port: number;
  servers: Map<string, any>;
  ports: Map<string, any>;
  nets: { id: string; name: string; subnet: string; capacity: number }[];
  calls: { method: string; path: string; body: any }[];
  opts: { maxInstances: number; buildMs: number; failBuild: boolean; expireTokenOnce: boolean; deleteMs: number };
  close(): Promise<void>;
}

export async function startMockOS(): Promise<MockOS> {
  let seq = 1;
  const id = (p: string) => `${p}-${(seq++).toString().padStart(4, "0")}`;
  const m: MockOS = {
    port: 0,
    servers: new Map(),
    ports: new Map(),
    nets: [
      { id: "net-01", name: "Internet-01", subnet: "sub-01", capacity: 2 },
      { id: "net-02", name: "Internet-02", subnet: "sub-02", capacity: 2 },
      { id: "net-v6", name: "Internet-IPv6-only", subnet: "", capacity: 99 }, // بدون IPv4
    ],
    calls: [],
    opts: { maxInstances: 10, buildMs: 120, failBuild: false, expireTokenOnce: false, deleteMs: 80 },
    close: async () => {},
  };
  const SG = "sg-allow-all";
  let ipn = 10;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const path = u.pathname;
      let body: any = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { /* */ }
      const send = (code: number, o: unknown = {}, h: Record<string, string> = {}) => {
        res.writeHead(code, { "Content-Type": "application/json", ...h });
        res.end(JSON.stringify(o));
      };
      const base = `http://127.0.0.1:${m.port}`;

      // ── Keystone ──
      if (path === "/identity/v3/auth/tokens") {
        m.calls.push({ method: "POST", path, body: { ...body, auth: "***" } });
        const ac = body?.auth?.identity?.application_credential;
        if (ac?.id !== "CID" || ac?.secret !== "CSEC") return send(401, { error: { message: "bad credential" } });
        const ep = (type: string, path: string) => ({ type, endpoints: ["r1", "r2"].map((r) => ({ interface: "public", region: r, region_id: r, url: `${base}/${r}${path}` })) });
        return send(201, {
          token: {
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            catalog: [ep("compute", "/compute/v2.1/PROJ"), ep("network", "/network/"), ep("image", "/image/")],
          },
        }, { "x-subject-token": "TOK" });
      }

      if (req.headers["x-auth-token"] !== "TOK") return send(401, { error: { message: "unauthorized" } });
      if (m.opts.expireTokenOnce) { m.opts.expireTokenOnce = false; return send(401, { error: { message: "expired" } }); }
      m.calls.push({ method: req.method!, path: path + u.search, body });

      const err = (code: number, key: string, message: string, type?: string) => send(code, { [key]: { message, code, ...(type ? { type } : {}) } });
      const rm = path.match(/^\/(r\d)\/(compute\/v2\.1\/PROJ|network|image)(.*)$/);
      const region = rm?.[1] ?? "";
      const nova = rm?.[2] === "compute/v2.1/PROJ";
      const neu = rm?.[2] === "network";
      const rest = rm ? rm[3] : "";
      const inR = (o: any) => o && o.region === region; // رکوردها فقط داخل ریجن خودشان دیده می‌شوند

      // ── Nova ──
      if (nova) {
        if (rest === "/flavors/detail") {
          return send(200, { flavors: region === "r2"
            ? [{ id: "R2-FLV-1", name: "hostvds-1", vcpus: 1, ram: 1024, disk: 10, "os-flavor-access:is_public": true }]
            : [
              { id: "FLV-1", name: "hostvds-1", vcpus: 1, ram: 1024, disk: 10, "os-flavor-access:is_public": true },
              { id: "FLV-2", name: "hostvds-2", vcpus: 1, ram: 2048, disk: 20, "os-flavor-access:is_public": true },
              { id: "FLV-HL", name: "highload-1", vcpus: 1, ram: 4096, disk: 30, "os-flavor-access:is_public": true },
              { id: "FLV-0", name: "nodisk", vcpus: 1, ram: 512, disk: 0, "os-flavor-access:is_public": true },
            ] });
        }
        if (rest === "/limits") {
          return send(200, { limits: { absolute: { totalInstancesUsed: [...m.servers.values()].filter(inR).length, maxTotalInstances: m.opts.maxInstances, totalCoresUsed: m.servers.size, maxTotalCores: 20, totalRAMUsed: 1024 * m.servers.size, maxTotalRAMSize: 51200 } } });
        }
        if (rest === "/servers/detail" && req.method === "GET") {
          const re = new RegExp(u.searchParams.get("name") ?? "");
          return send(200, { servers: [...m.servers.values()].filter((s) => inR(s) && re.test(s.name)).map(view) });
        }
        if (rest === "/servers" && req.method === "POST") {
          const s = body.server ?? {};
          if ([...m.servers.values()].filter(inR).length >= m.opts.maxInstances) return err(403, "forbidden", "Quota exceeded for instances: Requested 1, but already used 10 of 10 instances");
          if (!s.flavorRef || !s.imageRef || !s.name || !s.networks?.[0]?.port || !s.user_data) return err(400, "badRequest", "Invalid input for server");
          const p = m.ports.get(s.networks[0].port);
          if (!p || p.region !== region) return err(400, "badRequest", "Invalid input for field/attribute networks. port not found");
          const sid = id("srv");
          const rec: any = { id: sid, region, name: s.name, status: "BUILD", flavor: s.flavorRef, image: s.imageRef, userData: s.user_data, port: p.id, metadata: s.metadata };
          p.device_id = sid;
          m.servers.set(sid, rec);
          setTimeout(() => { if (m.servers.has(sid)) { rec.status = m.opts.failBuild ? "ERROR" : "ACTIVE"; if (m.opts.failBuild) rec.fault = { message: "No valid host was found", code: 500 }; } }, m.opts.buildMs);
          return send(202, { server: { id: sid } });
        }
        const sm = rest.match(/^\/servers\/([\w-]+)(\/action)?$/);
        if (sm) {
          const s = m.servers.get(sm[1]);
          if (!s || !inR(s)) return err(404, "itemNotFound", "Instance could not be found");
          if (!sm[2] && req.method === "GET") return send(200, { server: view(s) });
          if (!sm[2] && req.method === "DELETE") {
            s.status = "DELETED_PENDING";
            setTimeout(() => { m.servers.delete(s.id); const p = m.ports.get(s.port); if (p) p.device_id = ""; }, m.opts.deleteMs);
            return send(204);
          }
          if (sm[2] && req.method === "POST") {
            if ("os-stop" in body) { if (s.status !== "ACTIVE") return err(409, "conflictingRequest", "Cannot 'stop' instance while it is in vm_state stopped"); s.status = "SHUTOFF"; return send(202); }
            if ("os-start" in body) { if (s.status !== "SHUTOFF") return err(409, "conflictingRequest", "Cannot 'start' instance while it is in vm_state active"); s.status = "ACTIVE"; return send(202); }
            if ("reboot" in body) { s.rebooted = (s.rebooted ?? 0) + 1; return send(202); }
            if ("rebuild" in body) { s.image = body.rebuild.imageRef; s.userData = body.rebuild.user_data; s.rebuilt = true; return send(202, { server: view(s) }); }
          }
        }
      }

      // ── Glance ──
      if (rm?.[2] === "image" && rest === "/v2/images") {
        return send(200, { images: region === "r2"
          ? [{ id: "R2-IMG-U24", name: "Ubuntu-24.04-amd64", status: "active" }]
          : [
            { id: "IMG-U20", name: "Ubuntu-20.04-amd64", status: "active" },
            { id: "IMG-U22", name: "Ubuntu-22.04-amd64", status: "active" },
            { id: "IMG-U24", name: "Ubuntu-24.04-amd64", status: "active" },
            { id: "IMG-X", name: "prebuilt_3xui-v2.5.7_Ubuntu-24.04-amd64", status: "active" },
            { id: "IMG-OLD", name: "Debian-10-amd64", status: "active" },
          ] });
      }

      // ── Neutron ──
      if (neu) {
        if (rest === "/v2.0/networks") return send(200, { networks: m.nets.map((n) => ({ id: n.id, name: n.name })) });
        if (rest === "/v2.0/subnets") {
          return send(200, { subnets: m.nets.flatMap((n) => [{ id: `v6-${n.id}`, network_id: n.id, ip_version: 6, cidr: "2a13:7c00:9::/64" }, ...(n.subnet ? [{ id: n.subnet, network_id: n.id, ip_version: 4, cidr: n.id === "net-01" ? "13.140.80.0/24" : "13.140.85.0/24" }] : [])]) });
        }
        if (rest === "/v2.0/security-groups") {
          const nm = u.searchParams.get("name");
          return send(200, { security_groups: !nm || nm === "allow_all" ? [{ id: SG, name: "allow_all" }] : [] });
        }
        if (rest === "/v2.0/ports" && req.method === "GET") {
          const nm = u.searchParams.get("name");
          return send(200, { ports: [...m.ports.values()].filter((p) => inR(p) && (!nm || p.name === nm)) });
        }
        if (rest === "/v2.0/ports" && req.method === "POST") {
          const p = body.port ?? {};
          const n = m.nets.find((x) => x.id === p.network_id);
          if (!n) return err(404, "NeutronError", "Network not found", "NetworkNotFound");
          if (p.fixed_ips) return err(403, "NeutronError", "(rule:create_port and (rule:create_port:fixed_ips and (rule:create_port:fixed_ips:subnet_id))) is disallowed by policy", "PolicyNotAuthorized");
          if (p.security_groups?.[0] !== SG) return err(400, "NeutronError", "bad security group", "SecurityGroupNotFound");
          const full = n.capacity <= 0;
          // شبکه‌ی پر: net-01 فقط IPv6 می‌دهد (بدون خطا)؛ بقیه ۴۰۹ می‌دهند — هر دو رفتار واقعی Neutron است
          if (full && n.id !== "net-01") return err(409, "NeutronError", "No more IP addresses available on network " + n.id, "IpAddressGenerationFailure");
          if (!full) n.capacity--;
          const pid = id("port");
          const v6 = { ip_address: `2a13:7c00:9:${n.id === "net-01" ? 1 : 2}::${ipn}`, subnet_id: `v6-${n.id}` };
          const v4 = { ip_address: `13.140.${n.id === "net-01" ? 80 : 85}.${ipn++}`, subnet_id: n.subnet };
          const port = { id: pid, region, name: p.name, network_id: n.id, device_id: "", v4: !full, fixed_ips: full ? [v6] : [v6, v4] };
          m.ports.set(pid, port);
          return send(201, { port });
        }
        const pm = rest.match(/^\/v2\.0\/ports\/([\w-]+)$/);
        if (pm && req.method === "DELETE") {
          const p = m.ports.get(pm[1]);
          if (!p || !inR(p)) return err(404, "NeutronError", "Port not found", "PortNotFound");
          if (p.device_id) return err(409, "NeutronError", "Port is in use", "PortInUse");
          const n = m.nets.find((x) => x.id === p.network_id);
          if (n && p.v4) n.capacity++;
          m.ports.delete(p.id);
          return send(204);
        }
      }
      return err(404, "itemNotFound", "unknown route " + path);
    });
  });

  const view = (s: any) => ({
    id: s.id, name: s.name, status: s.status, fault: s.fault,
    // Nova هر آدرس پورت را با نسخه‌ی صحیح (4/6) برمی‌گرداند
    addresses: s.status === "ACTIVE" || s.status === "SHUTOFF"
      ? { [m.nets.find((n) => n.id === m.ports.get(s.port)?.network_id)?.name ?? "net"]: (m.ports.get(s.port)?.fixed_ips ?? []).map((f: any) => ({ addr: f.ip_address, version: f.ip_address.includes(":") ? 6 : 4 })) }
      : {},
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  m.port = (server.address() as any).port;
  m.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return m;
}
