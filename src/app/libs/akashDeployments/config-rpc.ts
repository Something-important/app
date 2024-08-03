// config-rpc.js
export const rpcEndpoints = [
    "https://rpc.akashnet.net:443",
    "https://akash-rpc.polkachu.com:443",
    "https://akash-rpc.skynetvalidators.com:443",
    "https://rpc-akash.ecostake.com:443",
    "https://akash-rpc.lavenderfive.com:443"
];

let currentIndex = 0;
const failedEndpoints = new Map();
const COOLDOWN_PERIOD = 5 * 60 * 1000; // 5 minutes in milliseconds

export function getNextRpcEndpoint() {
    const now = Date.now();
    let attempts = 0;
    
    while (attempts < rpcEndpoints.length) {
        const endpoint = rpcEndpoints[currentIndex];
        currentIndex = (currentIndex + 1) % rpcEndpoints.length;
        
        const failedTime = failedEndpoints.get(endpoint);
        if (!failedTime || now - failedTime > COOLDOWN_PERIOD) {
            failedEndpoints.delete(endpoint);
            return endpoint;
        }
        
        attempts++;
    }
    
    // If all endpoints are in cooldown, return the least recently failed one
    const [leastRecentlyFailedEndpoint] = [...failedEndpoints.entries()].reduce((a, b) => a[1] < b[1] ? a : b);
    failedEndpoints.delete(leastRecentlyFailedEndpoint);
    return leastRecentlyFailedEndpoint;
}

export function markEndpointAsFailed(endpoint) {
    failedEndpoints.set(endpoint, Date.now());
}