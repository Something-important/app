'use client';
import React, { useState, useEffect } from 'react';

interface Service {
  name: string;
  available: number;
  total: number;
  uris: string[];
}

interface Resources {
  cpu: string;
  memory: string;
  storage: string;
}

interface Deployment {
  dseq: string;
  owner: string;
  state: string;
  version: string;
  createdAt: string;
  provider: string;
  providerHostUri: string;
  publicUrl: string | null;
  services: Service[];
  resources: Resources;
  price: string;
  escrowAccount: {
    id: string;
    owner: string;
    state: number;
    balance: string;
  } | null;
  escrowBalance: string;
  logs: string;
  leaseState: number;
  leaseCreatedAt: string;
  leaseClosedOn: string;
}

interface TakeDownResult {
  success: boolean;
  message: string;
  dseq?: string;
  transactionHash?: string;
}

export default function AkashDeployments() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [takingDownDseqs, setTakingDownDseqs] = useState<string[]>([]);
  const [selectedDseqs, setSelectedDseqs] = useState<string[]>([]);
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null);
  const [activeTab, setActiveTab] = useState('General');

  useEffect(() => {
    fetchDeployments();
  }, []);

  const fetchDeployments = async () => {
    try {
      const response = await fetch('/api/deployments');
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch deployments');
      }
      const data = await response.json();
      console.log('Fetched data:', data); // Debug log
      
      if (Array.isArray(data)) {
        setDeployments(data);
      } else if (data && typeof data === 'object' && Array.isArray(data.deployments)) {
        setDeployments(data.deployments);
      } else {
        console.error('Unexpected data format:', data);
        throw new Error('Unexpected data format received from server');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
      console.error("Error fetching deployments:", err);
    } finally {
      setLoading(false);
    }
  };

  const destroyDeployments = async (dseqs: string[]) => {
    try {
      setTakingDownDseqs(dseqs);
      const response = await fetch(`/api/destroyDeployment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dseqs }),
      });
      const result = await response.json();
      
      if (result.success) {
        console.log("Selected deployments taken down successfully");
        result.results.forEach((r: TakeDownResult) => {
          if (r.success) {
            console.log(`Deployment ${r.dseq} taken down. Transaction hash: ${r.transactionHash}`);
          } else {
            console.error(`Failed to take down deployment ${r.dseq}: ${r.message}`);
          }
        });
        await fetchDeployments();
        setSelectedDseqs([]);
      } else {
        console.error("Some deployments failed to take down");
        result.results.forEach((r: TakeDownResult) => {
          if (!r.success) {
            console.error(`Failed to take down deployment ${r.dseq}: ${r.message}`);
          }
        });
        setError("Some deployments failed to take down. Check console for details.");
      }
    } catch (err) {
      console.error(`Failed to destroy deployments:`, err);
      setError(err instanceof Error ? err.message : `Failed to destroy deployments`);
    } finally {
      setTakingDownDseqs([]);
    }
  };

  const handleSelectDeployment = (dseq: string) => {
    setSelectedDseqs(prev => 
      prev.includes(dseq) ? prev.filter(d => d !== dseq) : [...prev, dseq]
    );
  };

  const handleSelectAll = () => {
    setSelectedDseqs(deployments.map(d => d.dseq));
  };

  const handleDeselectAll = () => {
    setSelectedDseqs([]);
  };

  const formatDate = (timestamp: string) => {
    return new Date(parseInt(timestamp) * 1000).toLocaleString();
  };

  const formatBytes = (bytes: string) => {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === '0') return '0 Byte';
    const i = parseInt(Math.floor(Math.log(parseInt(bytes)) / Math.log(1024)).toString());
    return Math.round(parseInt(bytes) / Math.pow(1024, i)) + ' ' + sizes[i];
  };

  if (loading) return <div className="text-center py-8">Loading deployments...</div>;
  if (error) return (
    <div className="text-center py-8 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">
      <strong className="font-bold">Error:</strong>
      <span className="block sm:inline"> {error}</span>
    </div>
  );

  if (!Array.isArray(deployments)) {
    console.error('deployments is not an array:', deployments);
    return <div className="text-center py-8">Error: Deployment data is in an unexpected format.</div>;
  }

  return (
    <div className="container mx-auto px-4">
      <h2 className="text-3xl font-bold mb-6">Your Deployments</h2>
      {deployments.length === 0 ? (
        <p className="text-xl text-gray-300">No deployments found.</p>
      ) : (
        <div>
          <div className="mb-4 flex justify-between items-center">
            <div>
              <button
                onClick={handleSelectAll}
                className="mr-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
              >
                Select All
              </button>
              <button
                onClick={handleDeselectAll}
                className="mr-2 bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-50"
              >
                Deselect All
              </button>
            </div>
            <button
              onClick={() => destroyDeployments(selectedDseqs)}
              disabled={selectedDseqs.length === 0}
              className={`bg-red-600 text-white px-4 py-2 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50 ${
                selectedDseqs.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-red-700'
              }`}
            >
              Destroy Selected Deployments ({selectedDseqs.length})
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {deployments.map((deployment) => (
              <div key={deployment.dseq} className="bg-gray-800 shadow-lg rounded-lg p-6 border border-gray-700">
                <div className="flex justify-between items-start mb-4">
                  <h3 className="text-2xl font-semibold text-blue-400">Deployment {deployment.dseq}</h3>
                  <input
                    type="checkbox"
                    checked={selectedDseqs.includes(deployment.dseq)}
                    onChange={() => handleSelectDeployment(deployment.dseq)}
                    className="form-checkbox h-5 w-5 text-blue-600"
                  />
                </div>
                <p className="text-gray-300 mb-2">
                  <span className="font-medium text-gray-400">Provider:</span> {deployment.provider}
                </p>
                <p className="text-gray-300 mb-2">
                  <span className="font-medium text-gray-400">Status:</span> 
                  <span className={`ml-2 px-2 py-1 rounded ${
                    deployment.state === 'active' ? 'bg-green-700 text-green-100' : 
                    deployment.state === 'closed' ? 'bg-red-700 text-red-100' : 
                    'bg-yellow-700 text-yellow-100'
                  }`}>
                    {deployment.state}
                  </span>
                </p>
                <p className="text-gray-300 mb-2">
                  <span className="font-medium text-gray-400">Created:</span> {formatDate(deployment.createdAt)}
                </p>
                <p className="text-gray-300 mb-2">
                  <span className="font-medium text-gray-400">Price:</span> {deployment.price}
                </p>
                {deployment.publicUrl && (
                  <p className="text-gray-300 mb-4">
                    <span className="font-medium text-gray-400">Public URL:</span>{' '}
                    <a href={deployment.publicUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
                      {deployment.publicUrl}
                    </a>
                  </p>
                )}
                <button
                  onClick={() => setSelectedDeployment(deployment)}
                  className="text-blue-400 hover:text-blue-300 underline mr-4"
                >
                  View Details
                </button>
                {takingDownDseqs.includes(deployment.dseq) ? (
                  <div className="w-full mt-4 bg-yellow-600 text-white px-4 py-2 rounded text-center">
                    Taking down deployment...
                  </div>
                ) : (
                  <button
                    onClick={() => destroyDeployments([deployment.dseq])}
                    className="w-full mt-4 bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
                  >
                    Destroy Deployment
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {selectedDeployment && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
          <div className="bg-gray-800 p-6 rounded-lg shadow-xl max-w-3xl w-full">
            <h3 className="text-2xl font-semibold text-blue-400 mb-4">Deployment Details: {selectedDeployment.dseq}</h3>
            <div className="flex mb-4">
              {['General', 'Resources', 'Services', 'Escrow', 'Logs'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 mr-2 rounded-t-lg ${
                    activeTab === tab
                      ? 'bg-gray-700 text-white'
                      : 'bg-gray-600 text-gray-300 hover:bg-gray-700 hover:text-white'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="bg-gray-700 rounded-xl p-3">
              {activeTab === 'General' && (
                <div>
                  <p><strong>Owner:</strong> {selectedDeployment.owner}</p>
                  <p><strong>Version:</strong> {selectedDeployment.version}</p>
                  <p><strong>Provider Host URI:</strong> {selectedDeployment.providerHostUri}</p>
                  <p><strong>Lease State:</strong> {selectedDeployment.leaseState}</p>
                  <p><strong>Lease Created:</strong> {formatDate(selectedDeployment.leaseCreatedAt)}</p>
                  <p><strong>Lease Closed On:</strong> {selectedDeployment.leaseClosedOn !== '0' ? formatDate(selectedDeployment.leaseClosedOn) : 'N/A'}</p>
                </div>
              )}
              {activeTab === 'Resources' && (
                <div>
                  <p><strong>CPU:</strong> {selectedDeployment.resources.cpu} units</p>
                  <p><strong>Memory:</strong> {formatBytes(selectedDeployment.resources.memory)}</p>
                  <p><strong>Storage:</strong> {formatBytes(selectedDeployment.resources.storage)}</p>
                </div>
              )}
              {activeTab === 'Services' && (
                <ul className="list-disc list-inside">
                  {selectedDeployment.services.map((service, index) => (
                    <li key={index}>
                      {service.name} ({service.available}/{service.total})
                      <ul className="list-disc list-inside ml-4">
                        {service.uris.map((uri, uriIndex) => (
                          <li key={uriIndex}>{uri}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              {activeTab === 'Escrow' && (
                <div>
                  <p><strong>Escrow Balance:</strong> {selectedDeployment.escrowBalance}</p>
                  {selectedDeployment.escrowAccount && (
                    <div>
                      <p><strong>Escrow Account:</strong></p>
                      <ul className="list-disc list-inside ml-4">
                        <li>ID: {selectedDeployment.escrowAccount.id}</li>
                        <li>Owner: {selectedDeployment.escrowAccount.owner}</li>
                        <li>State: {selectedDeployment.escrowAccount.state}</li>
                        <li>Balance: {selectedDeployment.escrowAccount.balance}</li>
                      </ul>
                    </div>
                  )}
                </div>
              )}
              {activeTab === 'Logs' && (
                <pre className="whitespace-pre-wrap overflow-auto max-h-96">
                  {selectedDeployment.logs || 'No logs available'}
                </pre>
              )}
            </div>
            <button
              onClick={() => setSelectedDeployment(null)}
              className="mt-4 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}