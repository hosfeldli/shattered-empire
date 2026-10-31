// Client preferences (this browser only; never match state): interface scale, graphics preset,
// motion and shake, particle density, faction markings, labels, notifications, overlays, layout.
const KEY = 'se.prefs';
export const DEFAULT_PREFS = {
  uiScale: 1, graphics: 'medium', shake: true, reducedMotion: false, particles: 1, factionPattern: false,
  labels: 'normal', notify: 'normal', tactical: false, minimap: 'compact', rail: 'compact', inspectorWidth: 340, highContrast: false,
};
export const GRAPHICS = {
  low: { particles: 0.35, decor: false, ambient: false, label: 'Low: essential effects and readable markers' },
  medium: { particles: 1, decor: true, ambient: true, label: 'Medium: smoke, movement and settlement activity' },
  high: { particles: 1.6, decor: true, ambient: true, label: 'High: denser particles and extra decoration' },
};

export function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* private window */ }
  return { ...DEFAULT_PREFS, ...p };
}
export function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

// apply the preferences that live in CSS
export function applyPrefs(p) {
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(p.uiScale));
  root.style.setProperty('--inspector-w', `${Math.max(280, Math.min(520, p.inspectorWidth))}px`);
  document.body.classList.toggle('reduced-motion', !!p.reducedMotion);
  document.body.classList.toggle('high-contrast', !!p.highContrast);
  document.body.classList.toggle('rail-expanded', p.rail === 'expanded');
  document.body.dataset.minimap = p.minimap;
}
