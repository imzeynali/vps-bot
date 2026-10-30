export interface Plan {
  id: number;
  name: string;
  cpu: number;
  ram_gb: number;
  ram_mb: number | null;
  disk_gb: number;
  hourly_price: number;
  active: boolean;
  virt_plid: number | null;
}

export interface ServiceRow {
  id: number;
  user_id: number;
  plan_id: number;
  location: string | null;
  os: string | null;
  ip: string | null;
  login_user: string | null;
  login_pass: string | null;
  power: "on" | "off";
  status: "active" | "suspended" | "deleted";
  hourly_price: number;
  created_at: Date;
  plan_name: string;
  cpu: number;
  ram_gb: number;
  ram_mb: number | null;
  disk_gb: number;
}
