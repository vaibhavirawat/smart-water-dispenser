// Set the theme before first paint to avoid a flash (an external file so the CSP can forbid inline scripts).
try { document.documentElement.dataset.theme = localStorage.getItem('swd_theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch { document.documentElement.dataset.theme = 'light'; }
