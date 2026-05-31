import React from 'react';
import { Play, Database, KeyRound, Terminal, Settings, BookOpen } from 'lucide-react';
import logoMark from '../assets/logo-mark.svg';

interface QuickStartProps {
  onConnect: () => void;
  onOpenSettings: () => void;
  hasConnections: boolean;
}

interface ActionCard {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  primary?: boolean;
}

export const QuickStart: React.FC<QuickStartProps> = ({ onConnect, onOpenSettings, hasConnections }) => {
  const actions: ActionCard[] = [
    {
      icon: <Play size={15} fill="currentColor" />,
      title: hasConnections ? 'Manage Connections' : 'Connect to a Database',
      description: hasConnections
        ? 'Open the connection manager to add or switch clusters.'
        : 'Add a MongoDB connection to start browsing collections.',
      onClick: onConnect,
      primary: true,
    },
    {
      icon: <Settings size={15} />,
      title: 'Settings',
      description: 'Tune appearance, density, and editor preferences.',
      onClick: onOpenSettings,
    },
  ];

  const tips: { icon: React.ReactNode; text: string }[] = [
    { icon: <Database size={13} />, text: 'Expand a connection in the sidebar to explore its databases and collections.' },
    { icon: <KeyRound size={13} />, text: 'Open a collection to inspect its indexes and query plans.' },
    { icon: <Terminal size={13} />, text: 'Launch a mongosh session from any collection to run ad-hoc commands.' },
  ];

  return (
    <div className="mql-quickstart" data-testid="quickstart-tab">
      <div className="mql-quickstart-inner">
        <div className="mql-quickstart-header">
          <div className="mql-welcome-badge">
            <img src={logoMark} alt="" className="mql-welcome-logo" />
          </div>
          <h1 className="mql-welcome-h">Welcome to MQLens</h1>
          <p className="mql-welcome-p">
            A focused workspace for browsing MongoDB clusters, inspecting indexes, and running queries.
          </p>
        </div>

        <div className="mql-quickstart-grid">
          {actions.map((action) => (
            <button
              key={action.title}
              onClick={action.onClick}
              className={`mql-quickstart-card ${action.primary ? 'is-primary' : ''}`}
            >
              <span className="mql-quickstart-card-icon">{action.icon}</span>
              <span className="mql-quickstart-card-body">
                <span className="mql-quickstart-card-title">{action.title}</span>
                <span className="mql-quickstart-card-desc">{action.description}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mql-quickstart-tips">
          <div className="mql-quickstart-tips-head">
            <BookOpen size={13} />
            <span>Getting started</span>
          </div>
          {tips.map((tip, i) => (
            <div key={i} className="mql-quickstart-tip">
              <span className="mql-quickstart-tip-icon">{tip.icon}</span>
              <span>{tip.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
