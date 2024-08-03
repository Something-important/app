// components/AkashDashboard.tsx
'use client';

import React, { useState } from 'react';
import AkashDeployments from './AkashDeployment';

type TabType = 'deployments' | 'create' | 'settings';

const TabContent: React.FC<{ activeTab: TabType }> = ({ activeTab }) => {
  switch (activeTab) {
    case 'deployments':
      return <AkashDeployments />;
    case 'create':
      return <div className="p-8 text-white">Create Deployment Form (Coming Soon)</div>;
    case 'settings':
      return <div className="p-8 text-white">Settings Page (Coming Soon)</div>;
    default:
      return null;
  }
};

export default function AkashDashboard() {
  const [activeTab, setActiveTab] = useState<TabType>('deployments');

  const tabs: { key: TabType; label: string }[] = [
    { key: 'deployments', label: 'Deployments' },
    { key: 'create', label: 'Create Deployment' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <div className="flex-1 overflow-auto bg-gray-900">
      <div className="border-b border-gray-700">
        <nav className="-mb-px flex">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              className={`py-4 px-6 text-sm font-medium ${
                activeTab === key
                  ? 'border-b-2 border-blue-500 text-blue-500'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <TabContent activeTab={activeTab} />
    </div>
  );
}