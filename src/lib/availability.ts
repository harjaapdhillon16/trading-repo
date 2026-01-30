import { pool } from "@/lib/db";
import type { WeekAvailability } from "@/lib/types";

type NqWeekRow = {
  week_start: string;
  days: string[];
  day_count: number;
};

const normalizeDay = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
};

export async function getAvailabilityWeeks(): Promise<WeekAvailability[]> {
  const { rows } = await pool.query<NqWeekRow>(`
    SELECT
      week_start::text AS week_start,
      days,
      day_count
    FROM nq_available_weeks
    ORDER BY week_start;
  `);

  return rows.map((row) => ({
    weekStart: row.week_start,
    days: (row.days ?? [])
      .map(normalizeDay)
      .filter((value): value is string => Boolean(value))
      .sort(),
  }));
}
