import { NextResponse } from "next/server";
import { getAvailabilityWeeks } from "@/lib/availability";

export const dynamic = "force-dynamic";

export async function GET() {
  const weeks = await getAvailabilityWeeks();
  return NextResponse.json({ weeks });
}
