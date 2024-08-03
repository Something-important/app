// app/api/destroyDeployment/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { takeDownDeployment } from '../../libs/akashDeployments/destroy';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { dseqs } = body;

  if (!dseqs || (Array.isArray(dseqs) && dseqs.length === 0)) {
    return NextResponse.json({ success: false, message: 'Invalid or missing dseq parameter' }, { status: 400 });
  }

  try {
    console.log(`Attempting to take down deployment(s) with dseq(s): ${Array.isArray(dseqs) ? dseqs.join(', ') : dseqs}`);
    const results = await takeDownDeployment(dseqs);
    
    const allSuccessful = results.every(result => result.success);
    const statusCode = allSuccessful ? 200 : 207; // Use 207 Multi-Status if not all were successful

    return NextResponse.json({ success: allSuccessful, results }, { status: statusCode });
  } catch (error) {
    console.error(`Error in deployment takedown:`, error);
    return NextResponse.json({ success: false, message: 'Internal Server Error', error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}