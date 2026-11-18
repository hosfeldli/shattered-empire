using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    /// <summary>
    /// Weapon recoil (effects pass, 2026-11-18). Every shot in the combat stream (NoteShot) restarts the shot age;
    /// these curves turn it into motion: a sharp run-back over ~20 ms and a slower return to battery.
    /// - Main guns: the barrel runs back in its turret (close detail) and the turret recoils a little on the hull at
    ///   mid zoom, where the barrel is not drawn separately.
    /// - The hull rocks on its suspension away from the line of fire (<see cref="HullKick"/>), artillery hardest.
    /// - Towed guns jump back on their carriage; rocket and missile launchers are shoved by the launch.
    /// Infantry keep their own subtle rifle kick (AddFigure / the rig's Fire clip).
    /// </summary>
    public sealed partial class UnitRenderer
    {
        /// <summary>Recoil displacement 0..~0.9: sharp run-back (attack), exponential return (settle), zero after `length` s.</summary>
        static float RecoilCurve(float shotAge, float attack, float settle, float length)
            => shotAge >= 0f && shotAge < length ? Mathf.Exp(-shotAge * settle) * (1f - Mathf.Exp(-shotAge * attack)) : 0f;

        /// <summary>Barrel run-back in model units (close detail tracked hulls).</summary>
        static float BarrelRecoil(Kind kind, float shotAge) => kind == Kind.SpGun
            ? RecoilCurve(shotAge, 150f, 4.2f, 1.3f) * .30f      // howitzer: a long recoil stroke, slow counter-recoil
            : RecoilCurve(shotAge, 140f, 6.5f, .85f) * .21f;     // tank gun

        /// <summary>How hard a shot rocks the hull on its suspension (pitch/roll rate impulse).</summary>
        static float HullKick(Kind kind, bool tracked) => kind switch
        {
            Kind.SpGun => 2.4f,
            Kind.Tank or Kind.AutoTank => 1.5f,
            Kind.Launcher => .9f,
            Kind.ArmoredCar => .12f,    // the gun truck's MG barely rocks it
            Kind.FieldGun => 1.2f,
            _ => tracked ? 1.1f : .45f,
        };

        /// <summary>
        /// Whole-body run-back (map units, per unit of vehicle scale) along the facing: a towed gun jumps back on its
        /// trail, an SP gun and a tank settle back a touch on the tracks.
        /// </summary>
        static float BodyRecoil(Kind kind, float shotAge) => kind switch
        {
            Kind.FieldGun => RecoilCurve(shotAge, 90f, 3.5f, 1.4f) * .07f,
            Kind.SpGun => RecoilCurve(shotAge, 120f, 5f, 1f) * .025f,
            Kind.Tank or Kind.AutoTank => RecoilCurve(shotAge, 120f, 7f, .7f) * .012f,
            Kind.Launcher => RecoilCurve(shotAge, 60f, 6f, .8f) * .015f,
            _ => 0f,
        };

        /// <summary>Map-space offset that moves a body back along direction `angle` (radians, map yaw) by its recoil.</summary>
        static float3 RecoilOffset(float angle, float amount)
        {
            if (amount <= 0f) return float3.zero;
            math.sincos(angle, out float s, out float c);
            return new float3(-s * amount, 0, -c * amount);
        }
    }
}
