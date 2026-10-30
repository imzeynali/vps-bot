CREATE TABLE IF NOT EXISTS users (
    id          BIGINT PRIMARY KEY,
    username    TEXT,
    balance     BIGINT NOT NULL DEFAULT 0,          -- تومان
    referrer_id BIGINT REFERENCES users(id),
    state       TEXT,                               -- وضعیت گفتگو (مثلاً topup_amount)
    state_data  JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    cpu          INT NOT NULL,
    ram_gb       INT NOT NULL,
    disk_gb      INT NOT NULL,
    hourly_price BIGINT NOT NULL,
    active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS services (
    id             SERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id),
    plan_id        INT NOT NULL REFERENCES plans(id),
    location       TEXT,
    os             TEXT,
    ip             TEXT,
    login_user     TEXT,
    login_pass     TEXT,
    power          TEXT NOT NULL DEFAULT 'on',       -- on / off
    status         TEXT NOT NULL DEFAULT 'active',   -- provisioning / active / suspended / failed / deleted
    hourly_price   BIGINT NOT NULL,
    last_billed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_services_user ON services(user_id);
CREATE INDEX IF NOT EXISTS idx_services_billing ON services(status, last_billed_at);

CREATE TABLE IF NOT EXISTS payments (
    id              SERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    amount          BIGINT NOT NULL,
    receipt_file_id TEXT,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_earnings (
    id          SERIAL PRIMARY KEY,
    referrer_id BIGINT NOT NULL REFERENCES users(id),
    referred_id BIGINT NOT NULL REFERENCES users(id),
    amount      BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS balance_adjustments (
    id            SERIAL PRIMARY KEY,
    admin_id      BIGINT NOT NULL,
    user_id       BIGINT NOT NULL REFERENCES users(id),
    amount        BIGINT NOT NULL,                  -- مثبت = افزایش، منفی = کاهش
    balance_after BIGINT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baladj_user ON balance_adjustments(user_id);

-- ارتقا از نسخه قبلی (پایتون)
ALTER TABLE users    ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS state_data JSONB;
ALTER TABLE services ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS os TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS power TEXT NOT NULL DEFAULT 'on';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
UPDATE payments SET approved_at = created_at WHERE status = 'approved' AND approved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_approved ON payments(status, approved_at);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

-- اتصال به Virtualizor
CREATE TABLE IF NOT EXISTS locations (
    key    TEXT PRIMARY KEY,                 -- مثلاً iran (فقط حروف/عدد/_)
    title  TEXT NOT NULL,                    -- عنوان نمایشی
    serid  INT  NOT NULL DEFAULT 0,          -- شناسه Server/Node در Virtualizor (0 = master)
    active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS os_templates (
    key    TEXT PRIMARY KEY,                 -- مثلاً u22
    name   TEXT NOT NULL,                    -- نام نمایشی، مثلاً Ubuntu 22.04
    osid   INT  NOT NULL,                    -- شناسه OS Template در Virtualizor
    active BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE plans    ADD COLUMN IF NOT EXISTS ram_mb INT;               -- (اختیاری) رم دقیق به مگابایت؛ اگر خالی باشد ram_gb*1024
ALTER TABLE plans    ADD COLUMN IF NOT EXISTS virt_plid INT;            -- (اختیاری) شناسه Plan در Virtualizor
ALTER TABLE services ADD COLUMN IF NOT EXISTS vps_id BIGINT;            -- شناسه VPS در Virtualizor
ALTER TABLE services ADD COLUMN IF NOT EXISTS panel_email TEXT;         -- کاربر اختصاصی این سرویس در Virtualizor
ALTER TABLE services ADD COLUMN IF NOT EXISTS panel_pass TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS location_key TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS os_key TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS provision_error TEXT;
CREATE INDEX IF NOT EXISTS idx_services_vps ON services(vps_id);

INSERT INTO plans (name, cpu, ram_gb, disk_gb, hourly_price)
SELECT * FROM (VALUES
    ('برنزی', 1, 1, 20, 300),
    ('نقره‌ای', 2, 4, 50, 900),
    ('طلایی', 4, 8, 100, 1800)
) AS v(name, cpu, ram_gb, disk_gb, hourly_price)
WHERE NOT EXISTS (SELECT 1 FROM plans);
