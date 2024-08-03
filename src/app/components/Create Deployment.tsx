'use client';
import React, { useState } from 'react';

export default function CreateDeploymentPage() {
  const [deploymentStatus, setDeploymentStatus] = useState<string | null>(null);

  const handleCreateDeployment = async () => {
    setDeploymentStatus('starting');
  
    try {
      //const response = await fetch('/api/deploy', { method: 'POST' });
      const response = { body: null, ok: true };
      if (!response.ok) {
        throw new Error('Deployment failed to start');
      }
  
      if (response.body !== null) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
  
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
  
          const events = decoder.decode(value).split('\n\n');
          for (const event of events) {
            if (event.startsWith('data: ')) {
              const data = JSON.parse(event.slice(6));
              setDeploymentStatus(data.status);
            }
          }
        }
      } else {
        console.error('Response body is null');
      }
    } catch (error) {
      console.error('Error during deployment:', error);
      setDeploymentStatus('failed');
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'completed':
        return 'text-green-400';
      case 'failed':
        return 'text-red-400';
      case 'in_progress':
      case 'starting':
        return 'text-blue-400';
      default:
        return 'text-gray-400';
    }
  };

  return (
    <div className="p-8 bg-gray-900 rounded-lg">
      <h2 className="text-3xl font-bold mb-6 text-white">Create New Deployment</h2>
      <button 
        onClick={handleCreateDeployment}
        className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded transition duration-300 ease-in-out"
        disabled={deploymentStatus === 'in_progress'}
      >
        Start Deployment
      </button>
      {deploymentStatus && (
        <p className={`mt-4 text-xl ${getStatusColor(deploymentStatus)}`}>
          Deployment status: {deploymentStatus}
        </p>
      )}
    </div>
  );
}
