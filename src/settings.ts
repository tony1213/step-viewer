import type { DisplayMode } from './viewer/model';
import type { Projection, UpAxis } from './viewer/viewer';

export interface Settings {
  upAxis: UpAxis;
  displayMode: DisplayMode;
  colorByPart: boolean;
  projection: Projection;
  /** the user has picked an up axis at least once (then we stop showing the hint) */
  upAxisChosen: boolean;
}

const KEY = 'step-viewer:settings';
const DEFAULTS: Settings = { upAxis: '+Y', displayMode: 'shaded-edges', colorByPart: false, projection: 'perspective', upAxisChosen: false };
const UP: UpAxis[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const MODES: DisplayMode[] = ['shaded-edges', 'shaded', 'edges'];

/** Per-browser preferences. Storage may be unavailable (private mode) – then defaults are used. */
export function loadSettings(): Settings {
  const s = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    if (raw.upAxis && UP.includes(raw.upAxis)) s.upAxis = raw.upAxis;
    if (raw.displayMode && MODES.includes(raw.displayMode)) s.displayMode = raw.displayMode;
    if (typeof raw.colorByPart === 'boolean') s.colorByPart = raw.colorByPart;
    if (raw.projection === 'perspective' || raw.projection === 'orthographic') s.projection = raw.projection;
    if (typeof raw.upAxisChosen === 'boolean') s.upAxisChosen = raw.upAxisChosen;
  } catch {
    /* ignore */
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
