const MAX_BOTS_PER_BACKEND = 100;
const BACKEND_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

export interface Backend {
  address: string;
  startTime: number;
  botCount: number;
}

export async function manageScaling(
  backends: Backend[],
  addBackend: (address: string) => Promise<void>,
  removeBackend: (address: string) => Promise<void>,
  totalBots: number
): Promise<void> {
  // Check if we need to add a new backend based on bot count
  if (totalBots > backends.length * MAX_BOTS_PER_BACKEND) {
    const newBackendAddress = `localhost:${3000 + backends.length + 1}`;
    await addBackend(newBackendAddress);
    backends.push({
      address: newBackendAddress,
      startTime: Date.now(),
      botCount: 0
    });
    console.log(`Added new backend: ${newBackendAddress}`);
  }

  // Check if any backends need to be removed due to age
  const currentTime = Date.now();
  for (let i = backends.length - 1; i >= 0; i--) {
    const backend = backends[i];
    if (currentTime - backend.startTime > BACKEND_LIFETIME_MS) {
      await removeBackend(backend.address);
      backends.splice(i, 1);
      console.log(`Removed backend due to age: ${backend.address}`);
    }
  }

  // Redistribute bots if necessary
  redistributeBots(backends, totalBots);
}

function redistributeBots(backends: Backend[], totalBots: number): void {
  let remainingBots = totalBots;
  for (let backend of backends) {
    backend.botCount = Math.min(MAX_BOTS_PER_BACKEND, remainingBots);
    remainingBots -= backend.botCount;
  }
}