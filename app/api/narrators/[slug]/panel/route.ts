import { NextRequest, NextResponse } from "next/server";
import { getNarratorPanelEvidence } from "@/lib/first-wahi-queries";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const chainIdParam = request.nextUrl.searchParams.get("chainId");
  const chainId = chainIdParam ? Number(chainIdParam) : null;
  if (chainIdParam && (!Number.isFinite(chainId) || chainId == null)) {
    return NextResponse.json({ error: "Invalid chainId." }, { status: 400 });
  }

  const { data, error } = await getNarratorPanelEvidence(slug, chainId);
  if (error) {
    return NextResponse.json({ error }, { status: error === "Narrator not found." ? 404 : 500 });
  }
  return NextResponse.json({ data });
}
