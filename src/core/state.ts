import { query, queryOne } from "./db";

export interface UserState {
  state: string | null;
  data: Record<string, unknown> | null;
}

export async function getState(userId: number): Promise<UserState> {
  const row = await queryOne<{ state: string | null; state_data: Record<string, unknown> | null }>(
    "SELECT state, state_data FROM users WHERE id=$1",
    [userId],
  );
  return { state: row?.state ?? null, data: row?.state_data ?? null };
}

export async function setState(userId: number, state: string | null, data: Record<string, unknown> | null = null) {
  await query("UPDATE users SET state=$2, state_data=$3 WHERE id=$1", [
    userId,
    state,
    data ? JSON.stringify(data) : null,
  ]);
}
