// Unit presentation from the texture atlas: an illustrated sprite per unit type (rotated to its
// heading) plus an accent layer tinted with the owner's colour; at strategic zoom a role symbol
// in a faction-coloured badge. Overlays (selection, health, supply, combat, veterancy) are drawn
// separately so the artwork never has to be re-rendered. Textures are shared across all units.
/* global PIXI */
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

// build the sprite layers inside a unit container
export function attachArt(s, atlas, type, def) {
  if (!atlas.has(type)) return false;
  s.art = new PIXI.Container();
  s.base = new PIXI.Sprite(atlas.tex[type]); s.base.anchor.set(0.5);
  s.accent = new PIXI.Sprite(atlas.tex[type + '_accent']); s.accent.anchor.set(0.5);
  s.art.addChild(s.base, s.accent);
  s.art.scale.set(SCALE[def.move] || 0.24);
  s.role = new PIXI.Container();
  s.roleBg = new PIXI.Graphics(); s.roleIcon = new PIXI.Sprite(atlas.tex[ROLE(def)]); s.roleIcon.anchor.set(0.5); s.roleIcon.scale.set(0.11);
  s.role.addChild(s.roleBg, s.roleIcon);
  s.addChildAt(s.art, 0); s.addChildAt(s.role, 1);
  return true;
}

// per frame: rotation, tint, level of detail
export function updateArt(s, u, def, S, heading, strategic) {
  if (!s.art) return;
  s.art.visible = !strategic; s.role.visible = strategic;
  if (strategic) {
    const col = S.civColor(u.owner);
    if (s.roleCol !== col) { s.roleCol = col; s.roleBg.clear().roundRect(-7.5, -5.5, 15, 11, 2).fill({ color: col }).stroke({ width: 1.2, color: 0x0b1518 }); s.roleIcon.tint = 0x0b1518; }
    return;
  }
  // infantry squads keep a steady facing; vehicles and aircraft turn with their heading
  s.art.rotation = def.move === 'infantry' && !def.civilian ? Math.round(heading / (Math.PI / 4)) * (Math.PI / 4) : heading;
  const col = S.civColor(u.owner);
  if (s.accent.tint !== col) s.accent.tint = col;
  s.base.alpha = u.refit > 0 ? 0.6 : 1;
}
export { ROLE };
