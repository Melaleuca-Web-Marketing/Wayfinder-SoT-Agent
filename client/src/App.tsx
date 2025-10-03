import { useState } from 'react';
import './App.css';
import { DocManager } from './components/DocManager';
import { ChatPanel } from './components/ChatPanel';
import { ApiStatusFooter } from './components/ApiStatusFooter';

type TabKey = 'chat' | 'docs';

const tabs: { key: TabKey; label: string; description: string }[] = [
  { key: 'chat', label: 'Chat', description: 'Conversational testing harness' },
  { key: 'docs', label: 'Documents', description: 'Manage vector store documents' },
];

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('chat');

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Melaleuca Knowledge Studio</h1>
          <p className="subtitle">Web-first RAG toolkit for Melaleuca & Riverbend Ranch teams</p>
        </div>
        <nav className="tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={tab.key === activeTab ? 'active' : ''}
              type="button"
              onClick={() => setActiveTab(tab.key)}
            >
              <span>{tab.label}</span>
              <small>{tab.description}</small>
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {activeTab === 'chat' ? <ChatPanel /> : <DocManager />}
      </main>

      <ApiStatusFooter />
    </div>
  );
}

export default App;
