// Unit presentation. Zoomed out every unit is a badge in its owner's colour
// carrying its own silhouette (UnitIcons): rifles, tanks, guns and aircraft are told apart at a
// glance. From operational zoom in, the illustrated sprite from the texture atlas (rotated to its heading, with an
// accent layer tinted in the owner's colour) takes over, with a small badge kept beside it.
// Overlays (selection, health, supply, combat, veterancy) are drawn separately so the artwork never
// has to be re-rendered. Textures are shared across all units.
/* global PIXI */
import { drawUnitIcon, drawBadge } from './UnitIcons.js';
const ROLE = (def) => (def.air ? 'role_air' : def.civilian && !def.supplyRadius ? 'role_civil' : def.cat === 'support' || def.civilian || def.engineer ? 'role_support' : def.cat === 'artillery' ? 'role_artillery' : def.cat === 'wheeled' && def.atk < 14 ? 'role_recon' : def.move === 'tracked' && def.men >= 8 ? 'role_mech' : def.move === 'infantry' ? 'role_infantry' : 'role_armor');
// world-space size of a 128 px frame
const SCALE = { aircraft: 0.27, tracked: 0.25, wheeled: 0.24, infantry: 0.24 };

export class UnitAtlas {
  constructor() { this.tex = null; this.ready = false; }
  async load() {
    try {
      const sheet = await PIXI.Assets.load('/assets/units/atlas.json');
      this.tex = sheet.textures; this.ready = !!this.tex && !!this.tex.tank;
    } catch (e) { console.warn('unit atlas unavailable, falling back to vector markers', e); this.ready = false; }
    return this.ready;
  }
  has(type) { return this.ready && !!this.tex[type]; }
}

// build the sprite layers inside a unit container: always the badge, the artwork when the atlas has it
export function attachArt(s, atlas, type, def) {
  s.role = new PIXI.Container();
  s.roleBg = new PIXI.Graphics(); s.roleIcon = new PIXI.Graphics(); drawUnitIcon(s.roleIcon, type, 0xffffff, def.move === 'infantry' ? 0.95 : 1.05);
  s.role.addChild(s.roleBg, s.roleIcon);
  s.addChildAt(s.role, 0);
  if (!atlas.has(type)) return false;
  s.art = new PIXI.Container();
  s.base = new PIXI.Sprite(atlas.tex[type]); s.base.anchor.set(0.5);
  s.accent = new PIXI.Sprite(atlas.tex[type + '_accent']); s.accent.anchor.set(0.5);
  s.art.addChild(s.base, s.accent);
  s.art.scale.set(SCALE[def.move] || 0.24);
  s.addChildAt(s.art, 0);
  return true;
}

// per frame: rotation, tint, level of detail (badge = show the icon badge instead of the artwork)
export function updateArt(s, u, def, S, heading, badge) {
  const col = S.civColor(u.owner);
  if (s.roleCol !== col) { s.roleCol = col; s.roleBg.clear(); drawBadge(s.roleBg, def, col, 8); }
  const showArt = !!s.art && !badge;
  s.role.visible = true;
  // close up the badge shrinks to a chip at the artwork's shoulder
  if (showArt) { s.role.scale.set(0.5); s.role.position.set(-9, -9); } else { s.role.scale.set(1); s.role.position.set(0, 0); }
  if (!s.art) return;
  s.art.visible = showArt;
  if (!showArt) return;
  // infantry squads keep a steady facing; vehicles and aircraft turn with their heading
  s.art.rotation = def.move === 'infantry' && !def.civilian ? Math.round(heading / (Math.PI / 4)) * (Math.PI / 4) : heading;
  if (s.accent.tint !== col) s.accent.tint = col;
  s.base.alpha = u.refit > 0 ? 0.6 : 1;
}
export { ROLE };
