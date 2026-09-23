function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5c.45 5.38 3.12 8.05 8.5 8.5-5.38.45-8.05 3.12-8.5 8.5-.45-5.38-3.12-8.05-8.5-8.5 5.38-.45 8.05-3.12 8.5-8.5Z" />
    </svg>
  )
}

const NAV_ITEMS = [
  {
    key: 'templates',
    label: 'Templates',
    path: '/agents/templates',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    key: 'agents',
    label: 'My Agents',
    path: '/agents',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2.5c.45 5.38 3.12 8.05 8.5 8.5-5.38.45-8.05 3.12-8.5 8.5-.45-5.38-3.12-8.05-8.5-8.5 5.38-.45 8.05-3.12 8.5-8.5Z" />
      </svg>
    ),
  },
  {
    key: 'tools',
    label: 'Tools & APIs',
    path: '/agents/tools',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    ),
  },
  {
    key: 'models',
    label: 'Models',
    path: '/agents/models',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
      </svg>
    ),
  },
  {
    key: 'registry',
    label: 'Agent Registry',
    path: '/agents/registry',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
        <circle cx="3.5" cy="6" r="1" fill="currentColor" /><circle cx="3.5" cy="12" r="1" fill="currentColor" /><circle cx="3.5" cy="18" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: 'evaluation',
    label: 'Evaluation',
    path: '/agents/evaluation',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
]

function isActive(itemPath, currentPath) {
  if (itemPath === '/agents') {
    return (
      currentPath === '/agents' ||
      currentPath === '/agents/new' ||
      /^\/agents\/\d+$/.test(currentPath)
    )
  }
  return currentPath === itemPath
}

export default function Shell({ children, navigate, currentPath }) {
  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon"><SparkleIcon /></div>
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-main">Agent Studio</span>
            <span className="sidebar-logo-sub">Payroll Platform</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Studio navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item${isActive(item.path, currentPath) ? ' nav-item-active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="studio-content">{children}</main>
    </div>
  )
}
