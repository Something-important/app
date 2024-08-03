import { deploy } from '../../libs/akashDeployments/deploy'; // Update this path when you have the actual location
import { NextRequest } from 'next/server';

export const config = {
  runtime: 'edge',
};

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Start the deployment process
        const deploymentPromise = deploy();

        // Send updates every 5 seconds
        const interval = setInterval(() => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'in_progress' })}\n\n`));
        }, 5000);

        // Wait for deployment to complete
        await deploymentPromise;

        // Clear the interval and send completion message
        clearInterval(interval);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'completed' })}\n\n`));
      } catch (error) {
        console.error('Deployment error:', error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'error', message: 'Deployment failed' })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}