export interface Plan {
  id: number;
  name: string;
  cpu: number;
  ram_gb: number;
  ram_mb: number | null;
  disk_gb: number;
  hourly_price: number;
  monthly_price: number | null;
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
  status: "provisioning" | "active" | "suspended" | "failed" | "deleted";
  hourly_price: number;
  billing_mode: "hourly" | "monthly";
  monthly_price: number | null;
  initial_charge: number;
  trial: boolean;
  trial_issue: boolean;
  period_end: Date | null;
  created_at: Date;
  plan_name: string;
  cpu: number;
  ram_gb: number;
  ram_mb: number | null;
  disk_gb: number;
}
