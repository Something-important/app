// app/api/deployments/route.ts
import { NextResponse } from 'next/server';
import { main } from '../../libs/akashDeployments/ip';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

async function retryOperation<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      lastError = error instanceof Error ? error : new Error('Unknown error');
      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error('Max retries reached');
}

export async function GET() {
  console.log("in route handler");
  try {
    const deployments = await retryOperation(() => main());
    console.log("Deployments:", deployments);
    return NextResponse.json({ deployments });
  } catch (error) {
    console.error("Error in API route:", error);
    let statusCode = 500;
    let errorMessage = 'An unknown error occurred';

    if (error instanceof Error) {
      if (error.message.includes('Connect Timeout Error')) {
        statusCode = 504;
        errorMessage = 'Connection to Akash network timed out. Please try again later.';
      } else if (error.message.includes('fetch failed')) {
        statusCode = 503;
        errorMessage = 'Unable to connect to Akash network. Please check your internet connection and try again.';
      } else if (error.message.includes('Max retries reached')) {
        statusCode = 503;
        errorMessage = 'Unable to connect to Akash network after multiple attempts. Please try again later.';
      }
    }

    return NextResponse.json({ error: errorMessage }, { status: statusCode });
  }
}