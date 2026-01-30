import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

// CONSTANTS: 9:30 AM to 4:10 PM (New York)
const MARKET_OPEN_MIN = 570; // 9 * 60 + 30
const MARKET_CLOSE_MIN = 1000; // 16 * 60 + 10

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const instrument = searchParams.get("instrument");
  const day = searchParams.get("day");
  // Default to Market Hours if not specified
  const startMinute = Number(searchParams.get("startMinute") ?? MARKET_OPEN_MIN);
  const endMinute = Number(searchParams.get("endMinute") ?? MARKET_CLOSE_MIN);
  const cursor = searchParams.get("cursor") ?? "0";
  const limit = Math.min(Number(searchParams.get("limit") ?? "50000"), 100000);

  if (!instrument || !day) {
    return NextResponse.json({ error: "Missing instrument/day" }, { status: 400 });
  }

  const table = instrument === "es" ? "es" : "nq";
  let symbol = searchParams.get("symbol")?.trim();

  // 1. Auto-detect symbol if missing
  if (!symbol) {
    const symbolSql = `
      SELECT symbol FROM ${table}
      WHERE ny_trading_day = $1::date
      GROUP BY symbol ORDER BY count(*) DESC LIMIT 1;
    `;
    try {
      const res = await pool.query(symbolSql, [day]);
      symbol = res.rows[0]?.symbol;
    } catch (e) {
      console.error("Symbol detection failed:", e);
    }
  }

  if (!symbol) {
    return NextResponse.json({ ticks: [], nextCursor: cursor, done: true, symbol: null });
  }

  // 2. Fetch Ticks (Strictly within Start/End minutes)
  const sql = `
    SELECT
      ts_event_ns::text as ts,
      close::float8 as price,
      volume::bigint as volume,
      ny_minute_of_day as m
    FROM ${table}
    WHERE symbol = $1
      AND ny_trading_day = $2::date
      AND ny_minute_of_day >= $3
      AND ny_minute_of_day <= $4
      AND ts_event_ns > $5
    ORDER BY ts_event_ns ASC
    LIMIT $6
  `;

  try {
    const { rows } = await pool.query(sql, [
      symbol,
      day,
      startMinute,
      endMinute,
      cursor,
      limit,
    ]);

    const nextCursor = rows.length > 0 ? rows[rows.length - 1].ts : cursor;

    return NextResponse.json({
      ticks: rows.map((row) => ({
        ts: row.ts,
        price: row.price,
        volume: Number(row.volume),
        m: row.m,
      })),
      nextCursor,
      done: rows.length < limit,
      symbol,
    });
  } catch (err) {
    console.error("[API] Query Error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}