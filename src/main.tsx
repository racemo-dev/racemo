import { createRoot } from 'react-dom/client'
import './index.css'
import { isLinux } from './lib/osUtils'


if (isLinux()) {
  document.documentElement.classList.add('platform-linux')
}

const page = new URLSearchParams(window.location.search).get("page");

function showAfterPaint() {
  requestAnimationFrame(() => {
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().show();
    });
  });
}

if (page === "settings") {
  import('./SettingsPage').then(({ default: SettingsPage }) => {
    createRoot(document.getElementById('root')!).render(<SettingsPage />);
    showAfterPaint();
  });
} else if (page === "editor") {
  import('./EditorPage').then(({ default: EditorPage }) => {
    createRoot(document.getElementById('root')!).render(<EditorPage />);
    showAfterPaint();
  });
} else if (page === "diff") {
  import('./DiffPage').then(({ default: DiffPage }) => {
    createRoot(document.getElementById('root')!).render(<DiffPage />);
    showAfterPaint();
  });
} else {
  import('./App').then(({ default: App }) => {
    createRoot(document.getElementById('root')!).render(<App />);
  });
}
