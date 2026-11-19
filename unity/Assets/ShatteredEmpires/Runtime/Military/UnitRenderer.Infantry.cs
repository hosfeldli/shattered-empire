using System;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    /// <summary>
    /// Infantry motion. The server sends one point per squad at 10 Hz. Here that point is smoothed
    /// (a critically damped follower fed the measured velocity, so steady marching has no lag), and
    /// every soldier keeps a little state of his own on top of the place AddSquad picks for him
    /// (formation, trench, cover, mortar crew spot): a spring toward that place, so the squad flows
    /// round corners and men dash rather than teleport; a heading turned at a limited, eased rate;
    /// gait phases advanced by the distance he actually covered (the baked rig's clip and the
    /// procedural figure's variable stride, so feet stay planted); and eased walk / run / kneel weights.
    /// The procedural figure (used when a role has no baked rig) gets a full walk/run cycle, idle
    /// breathing and weight shift, lean, bank, flinch and staggered recoil.
    /// See docs/gameplay-overhaul/INFANTRY_ANIMATION.md.
    /// </summary>
    public sealed partial class UnitRenderer
    {
        const float Tau = math.PI * 2f;

        // per slot: smoothed squad point (base image), its velocity, the velocity it is fed, hits
        float[] sqX = new float[0], sqZ = new float[0], sqVx = new float[0], sqVz = new float[0], sqTx = new float[0], sqTz = new float[0];
        float[] hitAt = new float[0];
        int[] hpSeen = new int[0], figFrame = new int[0], figKnown = new int[0];
        // per soldier (slot * MaxFigures + figure)
        float[] relX = new float[0], relZ = new float[0], relVx = new float[0], relVz = new float[0];
        float[] figVx = new float[0], figVz = new float[0], figHead = new float[0], figTurn = new float[0];
        float[] figGait = new float[0], figRig = new float[0], figLoco = new float[0], figRun = new float[0], figKneel = new float[0], figLean = new float[0];
        int frameNo;

        /// <summary>A soldier's own motion this frame, for the procedural figure (Valid false: derive from the pose).</summary>
        struct FigureGait
        {
            public bool Valid;
            public float Phase;          // gait phase (radians), advanced by distance over StrideLength
            public float Loco, Run;      // 0 standing .. 1 moving; 0 walk .. 1 run
            public float StrideLength;   // map units per full gait cycle
            public float2 Move;          // direction of travel in the body frame (x: model +x, y: forward)
            public float Lean, Bank, Kneel, Flinch;
        }

        /// <summary>Everything the procedural soldier's pose needs (map space unless noted).</summary>
        struct Pose
        {
            public float3 Foot;
            public float Facing;         // map yaw
            public float Scale;
            public float4 Color;
            public float Gait, Loco, Run, StrideLength;
            public float2 Move;
            public float Lean, Bank;
            public float Aim, Kneel, Flinch;
            public float ShotAge;
            public bool ReloadCycle;
            public float Life;           // per-soldier 0..1 phase for idle motion
            public float Time;
        }

        static bool IsFoot(Kind k) => k == Kind.Infantry || k == Kind.Mortar || k == Kind.Exo;

        void EnsureInfantry(int s)
        {
            if (sqX.Length >= s) return;
            Array.Resize(ref sqX, s); Array.Resize(ref sqZ, s); Array.Resize(ref sqVx, s); Array.Resize(ref sqVz, s);
            Array.Resize(ref sqTx, s); Array.Resize(ref sqTz, s); Array.Resize(ref hitAt, s);
            Array.Resize(ref hpSeen, s); Array.Resize(ref figKnown, s);
            int old = figFrame.Length;
            Array.Resize(ref figFrame, s);
            for (int i = old; i < s; i++) figFrame[i] = int.MinValue;
            int n = s * MaxFigures;
            Array.Resize(ref relX, n); Array.Resize(ref relZ, n); Array.Resize(ref relVx, n); Array.Resize(ref relVz, n);
            Array.Resize(ref figVx, n); Array.Resize(ref figVz, n); Array.Resize(ref figHead, n); Array.Resize(ref figTurn, n);
            Array.Resize(ref figGait, n); Array.Resize(ref figRig, n); Array.Resize(ref figLoco, n); Array.Resize(ref figRun, n);
            Array.Resize(ref figKneel, n); Array.Resize(ref figLean, n);
        }

        /// <summary>
        /// Pass 1, every foot unit: follow the interpolated snapshot point with a critically damped spring that
        /// is also fed its measured velocity. Corners and snapshot seams are rounded off, a late snapshot no
        /// longer stops the squad dead, and steady marching has no lag. px/pz stay raw (picking, aiming).
        /// </summary>
        void TrackFoot(int s, bool fresh, float oldX, float oldZ, int hp, HexGrid grid, float dt, float time)
        {
            if (fresh)
            {
                sqX[s] = px[s]; sqZ[s] = pz[s];
                sqVx[s] = sqVz[s] = sqTx[s] = sqTz[s] = 0;
                hpSeen[s] = hp; hitAt[s] = -100f; figFrame[s] = int.MinValue;
                return;
            }
            if (hp < hpSeen[s]) hitAt[s] = time;
            hpSeen[s] = hp;
            if (dt <= 0f) return;
            float mvx = grid.DxWrap(oldX, px[s]) / dt, mvz = (pz[s] - oldZ) / dt;
            if (mvx * mvx + mvz * mvz > 9f) mvx = mvz = 0f;   // a jump (respawn, correction) is not a velocity
            float k = 1f - Mathf.Exp(-dt * 14f);
            sqTx[s] += (mvx - sqTx[s]) * k;
            sqTz[s] += (mvz - sqTz[s]) * k;
            const float w = 9f;
            float remaining = Mathf.Min(dt, .2f);
            while (remaining > 1e-5f)
            {
                float h = Mathf.Min(remaining, 1f / 60f);
                remaining -= h;
                float ex = grid.DxWrap(sqX[s], px[s]), ez = pz[s] - sqZ[s];
                if (ex * ex + ez * ez > .25f)
                {
                    sqX[s] = px[s]; sqZ[s] = pz[s]; sqVx[s] = sqTx[s]; sqVz[s] = sqTz[s];
                    break;
                }
                sqVx[s] += (w * w * ex + 2f * w * (sqTx[s] - sqVx[s])) * h;
                sqVz[s] += (w * w * ez + 2f * w * (sqTz[s] - sqVz[s])) * h;
                sqX[s] += sqVx[s] * h;
                sqZ[s] += sqVz[s] * h;
            }
            sqX[s] = grid.BaseX(sqX[s]);
        }

        /// <summary>
        /// Start a squad's soldiers this frame: how many of them carry state from last frame (the rest start
        /// afresh at their places; this covers zooming in, LOD changes and squads that were culled).
        /// </summary>
        int BeginFigures(int slot, int figures)
        {
            int known = figFrame[slot] == frameNo - 1 || figFrame[slot] == frameNo ? figKnown[slot] : 0;
            figFrame[slot] = frameNo; figKnown[slot] = figures;
            return known;
        }

        /// <summary>
        /// One soldier follows the place AddSquad chose for him (fx, fz in, his drawn point out): a critically
        /// damped spring of his own stiffness, trailing the squad by his own reaction time, kept inside the ring.
        /// Advances his gait phases by the distance he covered and eases his walk / run weights and lean.
        /// rigCycle is the baked clips' stride (map units per cycle).
        /// </summary>
        FigureGait FollowFigure(int slot, int f, int seed, int known, float x, float z, ref float fx, ref float fz, float reach,
            float rigCycle, float dt, float time, out float rigStride, out float rigPhase)
        {
            int i = slot * MaxFigures + f;
            float vx = sqVx[slot], vz = sqVz[slot];
            float leg = .467f * WorldScale.Soldier;   // hip-to-ankle length, the unit of stride
            float t0 = Trait(seed, 20), t1 = Trait(seed, 21), t2 = Trait(seed, 22), t3 = Trait(seed, 23);
            // the file stretches on the move, the last men start late and close up when the squad halts
            float lag = .05f + .09f * t3;
            float ox = fx - x - vx * lag, oz = fz - z - vz * lag;
            float pvx = figVx[i], pvz = figVz[i];
            if (f >= known)
            {
                relX[i] = ox; relZ[i] = oz; relVx[i] = relVz[i] = 0;
                figVx[i] = pvx = vx; figVz[i] = pvz = vz;
                float r0 = Mathf.Sqrt(vx * vx + vz * vz) / leg;
                figHead[i] = float.NaN;   // SteerFigure takes the wanted heading on the first frame
                figTurn[i] = 0; figGait[i] = t1 * Tau; figRig[i] = t0 * Tau; figLean[i] = 0; figKneel[i] = 0;
                figLoco[i] = math.smoothstep(.3f, 1.4f, r0);
                figRun[i] = math.smoothstep(3.5f, 9f, r0);
            }
            else
            {
                float sdt = Mathf.Min(dt, .05f);
                float w = 4.5f + 3f * t2;
                relVx[i] += (w * w * (ox - relX[i]) - 2f * w * relVx[i]) * sdt;
                relVz[i] += (w * w * (oz - relZ[i]) - 2f * w * relVz[i]) * sdt;
                float rv = relVx[i] * relVx[i] + relVz[i] * relVz[i];
                if (rv > 1.44f) { float c = 1.2f / Mathf.Sqrt(rv); relVx[i] *= c; relVz[i] *= c; }
                relX[i] += relVx[i] * sdt; relZ[i] += relVz[i] * sdt;
                float ex = ox - relX[i], ez = oz - relZ[i];
                if (ex * ex + ez * ez > .16f) { relX[i] = ox; relZ[i] = oz; relVx[i] = relVz[i] = 0; }
            }
            // drawn inside the squad's team ring, like every place AddSquad picks
            float rx = relX[i], rz = relZ[i], r2 = rx * rx + rz * rz;
            if (r2 > reach * reach) { float k = reach / Mathf.Sqrt(r2); rx *= k; rz *= k; }
            fx = x + rx; fz = z + rz;
            // his ground velocity: the squad's plus his own movement within it
            float kSmooth = 1f - Mathf.Exp(-dt * 9f);
            figVx[i] += (vx + relVx[i] - figVx[i]) * kSmooth;
            figVz[i] += (vz + relVz[i] - figVz[i]) * kSmooth;
            float spd = Mathf.Sqrt(figVx[i] * figVx[i] + figVz[i] * figVz[i]);
            float r = spd / leg;   // leg lengths per second
            figLoco[i] += (math.smoothstep(.3f, 1.4f, r) - figLoco[i]) * (1f - Mathf.Exp(-dt * 6f));
            figRun[i] += (math.smoothstep(3.5f, 9f, r) - figRun[i]) * (1f - Mathf.Exp(-dt * 3f));
            // procedural stride grows with speed up to a full run (cadence follows); the baked clips keep their
            // fixed stride (as before), each man on his own phase
            float strideLength = leg * math.clamp(1.15f + .16f * r, 1.15f, 4.2f) * (.94f + .12f * t0);
            if (dt > 0f)
            {
                figGait[i] = (figGait[i] + spd * dt / strideLength * Tau) % Tau;
                figRig[i] = (figRig[i] + spd * dt / rigCycle * Tau) % Tau;
            }
            rigStride = figLoco[i] * math.saturate(spd / .11f);
            rigPhase = figRig[i];
            float accel = 0f;
            if (dt > 0f && spd > 1e-4f) accel = ((figVx[i] - pvx) * figVx[i] + (figVz[i] - pvz) * figVz[i]) / (spd * dt);
            figLean[i] += (Mathf.Clamp(accel * .05f, -.1f, .16f) - figLean[i]) * (1f - Mathf.Exp(-dt * 5f));
            float hitAge = time - hitAt[slot];
            return new FigureGait
            {
                Valid = true, Phase = figGait[i], Loco = figLoco[i], Run = figRun[i], StrideLength = strideLength, Lean = figLean[i],
                Flinch = hitAge >= 0f && hitAge < .7f ? Mathf.Exp(-hitAge * 6f) * (1f - Mathf.Exp(-hitAge * 40f)) * (.35f + .65f * t3) : 0f,
                Move = new float2(0, 1),
            };
        }

        /// <summary>
        /// The soldier's heading: the one AddSquad wants (squad facing, threat, trench, tube, dash), or along his
        /// own path when he is free to (moving, not engaged), with a slow look around at ease; turned with an
        /// eased, limited rate. Fills in his direction of travel in the body frame, the bank and the kneel weight.
        /// </summary>
        float SteerFigure(int slot, int f, int seed, float want, bool free, bool kneel, float dt, float time, ref FigureGait gait)
        {
            int i = slot * MaxFigures + f;
            float fvx = figVx[i], fvz = figVz[i];
            float spd = Mathf.Sqrt(fvx * fvx + fvz * fvz);
            float leg = .467f * WorldScale.Soldier;
            if (free)
            {
                if (spd > leg * 1.6f) want = Mathf.Atan2(fvx, fvz);
                else want += .2f * Mathf.Sin(time * .19f + Trait(seed, 24) * Tau) * (1f - figLoco[i]);
            }
            if (float.IsNaN(figHead[i])) figHead[i] = want;
            float delta = Mathf.DeltaAngle(figHead[i] * Mathf.Rad2Deg, want * Mathf.Rad2Deg) * Mathf.Deg2Rad;
            float maxRate = Mathf.Lerp(3.2f, 7f, figLoco[i]);
            figTurn[i] += (Mathf.Clamp(delta * 6f, -maxRate, maxRate) - figTurn[i]) * (1f - Mathf.Exp(-dt * 10f));
            figHead[i] += figTurn[i] * dt;
            if (figHead[i] > math.PI) figHead[i] -= Tau; else if (figHead[i] < -math.PI) figHead[i] += Tau;
            float head = figHead[i];
            math.sincos(head, out float hs, out float hc);
            // model +x is map left, +z forward
            gait.Move = spd > 1e-4f ? new float2(fvz * hs - fvx * hc, fvx * hs + fvz * hc) / spd : new float2(0, 1);
            gait.Bank = Mathf.Clamp(figTurn[i] * spd * .03f, -.15f, .15f);
            figKneel[i] += ((kneel ? 1f : 0f) - figKneel[i]) * (1f - Mathf.Exp(-dt * 4f));
            gait.Kneel = figKneel[i];
            return head;
        }

        /// <summary>The operational-zoom soldier (one mesh): still bobbing, leaning and banking with his stride.</summary>
        void AddSimpleFigure(Model model, float3 foot, float heading, float scale, float4 color, in FigureGait gait)
        {
            float loco = gait.Loco, run = gait.Run * loco;
            float bob = loco * Mathf.Abs(Mathf.Sin(gait.Phase)) * Mathf.Lerp(.012f, .03f, run) - gait.Kneel * .15f;
            var rot = math.mul(quaternion.RotateY(MapSpace.Yaw(heading)), quaternion.EulerZXY(.05f * loco + .14f * run + gait.Lean, 0, gait.Bank));
            batches[(int)model].Add(Q(foot + new float3(0, bob * scale, 0), rot, new float3(scale), color));
        }

        /// <summary>
        /// The procedural soldier (roles without a baked rig, and field-gun crews). With a FigureGait from
        /// AddSquad it moves on the soldier's own motion; otherwise the pose and legacy stride / phase decide.
        /// </summary>
        void ProceduralFigure(Detail torso, float3 foot, float facing, float scale, float4 color, float stride, float aim, float phase, float shotAge,
            int equipment, TerrainView groundView, bool assisting, bool reloadCycle, int seed, int pose, float poseTime, in FigureGait gait)
        {
            var q = new Pose
            {
                Foot = foot, Facing = facing, Scale = scale, Color = color, Aim = aim, Move = new float2(0, 1),
                ShotAge = shotAge - Trait(seed, 4) * .22f,   // the same reaction delay as the rig: volleys ripple
                ReloadCycle = reloadCycle, Life = Trait(seed, 7), Time = Time.time,
            };
            if (gait.Valid)
            {
                q.Gait = gait.Phase; q.Loco = gait.Loco; q.Run = gait.Run; q.StrideLength = gait.StrideLength; q.Move = gait.Move;
                q.Lean = gait.Lean; q.Bank = gait.Bank; q.Kneel = gait.Kneel; q.Flinch = gait.Flinch;
            }
            else
            {
                q.Gait = phase; q.Loco = stride; q.Run = stride > .72f ? 1f : 0f; q.StrideLength = .056f;
                q.Kneel = pose == PoseKneel || pose == PoseDeploy ? 1f : 0f;
            }
            switch (pose)
            {
                case PoseKneel: q.Aim = 1f; break;
                case PoseDeploy: q.Aim = 1f; q.Lean += .3f; break;   // bent over the tube or the breech
                case PoseDash:
                    q.Aim = Mathf.Max(q.Aim, .4f);   // a crouching run
                    if (!gait.Valid) { q.Loco = 1f; q.Run = 1f; q.Gait = poseTime * Tau; }
                    else q.Run = Mathf.Max(q.Run, .7f);
                    break;
                case PoseHop:
                    if (!gait.Valid) { q.Loco = .5f; q.Gait = poseTime * math.PI; }
                    break;
            }
            PoseFigure(torso, q, equipment, groundView, assisting);
        }

        void PoseFigure(Detail torso, in Pose q, int equipment, TerrainView groundView, bool assisting)
        {
            float scale = q.Scale, loco = q.Loco, aim = q.Aim, kneel = q.Kneel, idle = 1f - loco;
            float run = q.Run;
            // the gait: each foot is planted for the stance share of the cycle and travels back under the body by
            // exactly what the body covers meanwhile; running shortens the stance and adds a flight phase, so long
            // running strides need no impossible reach
            float strideScaled = q.StrideLength / scale;
            float duty = Mathf.Lerp(.6f, .34f, run);
            float stance = Mathf.Min(duty * strideScaled, .40f);
            if (strideScaled > 1e-4f) duty = Mathf.Min(duty, stance / strideScaled);
            duty = Mathf.Max(duty, .12f);
            float amp = stance * .5f;
            float lift = Mathf.Lerp(.08f, .2f, run) * math.saturate(strideScaled * 2f);
            float mid = math.PI * duty;   // gait phase of the +x foot's mid-stance
            float g = q.Gait;
            float3 footR = default, footL = default;
            float advR = 0, advL = 0;
            for (int side = -1; side <= 1; side += 2)
            {
                float c = math.frac((g + (side < 0 ? math.PI : 0)) / Tau);
                float adv, up = 0;
                if (c < duty) adv = Mathf.Lerp(amp, -amp, c / duty);
                else
                {
                    float u = (c - duty) / (1f - duty);
                    adv = Mathf.Lerp(-amp, amp, u * u * (3f - 2f * u));
                    up = Mathf.Sin(math.PI * Mathf.Pow(u, .8f)) * lift;
                }
                float width = Mathf.Lerp(.075f, .052f, run * loco);
                var local = new float3(side * width, .029f + up * loco, 0);
                local.x += q.Move.x * adv * loco;
                local.z += q.Move.y * adv * loco;
                // standing: feet a little apart, one slightly ahead (per soldier)
                local.z += idle * (q.Life - .5f) * .12f * side;
                local.x += idle * side * .012f;
                // kneeling: +x knee down with the foot behind, the other foot planted forward
                local = math.lerp(local, side > 0 ? new float3(.07f, .03f, -.25f) : new float3(-.095f, .029f, .19f), kneel);
                float norm = amp > 1e-4f ? adv / amp * loco : 0f;
                if (side > 0) { footR = local; advR = norm; } else { footL = local; advL = norm; }
            }

            float breathe = Mathf.Sin(q.Time * 1.7f + q.Life * Tau);
            float shift = Mathf.Sin(q.Time * .37f + q.Life * 11f);
            float c2 = Mathf.Cos(2f * (g - mid));
            // walking vaults over the planted leg (highest at mid-stance); running compresses on it
            float bob = loco * Mathf.Lerp(.014f * c2, -.028f * c2 - .014f, run) + breathe * .004f * idle;
            float sway = loco * (1f - run) * .016f * Mathf.Cos(g - mid) + idle * (1f - kneel) * .012f * shift;
            float crouch = aim * idle * (1f - kneel) * .07f + aim * loco * .05f + kneel * .19f + q.Flinch * .035f;
            var turn = quaternion.RotateY(MapSpace.Yaw(q.Facing));
            var origin = MapSpace.W(q.Foot);
            var root = origin + math.rotate(turn, new float3(sway, bob - crouch, 0) * scale);
            float pitch = .05f * loco + .17f * run * loco + q.Lean + .19f * aim * (1f - .5f * kneel) + breathe * .012f * idle - q.Flinch * .3f;
            float twist = .1f * (advR - advL) * .5f * (1f - .5f * aim);
            float roll = q.Bank - loco * (1f - run) * .035f * Mathf.Cos(g - mid) + idle * (1f - kneel) * .02f * shift;
            var chest = math.mul(turn, quaternion.EulerZXY(pitch, twist, roll));
            var torsoOrigin = root + math.rotate(turn, new float3(0, .453f * scale, 0)) - math.rotate(chest, new float3(0, .453f * scale, 0));
            DetailPart(torso, torsoOrigin, chest, scale, q.Color);

            float shotAge = q.ShotAge;
            float recoil = shotAge >= 0f && shotAge < .25f ? Mathf.Exp(-shotAge * 19) * (1 - Mathf.Exp(-shotAge * 180)) * .065f : 0f;
            float reload = q.ReloadCycle && shotAge > .50f && shotAge < 1.45f ? Mathf.Sin((shotAge - .50f) / .95f * Mathf.PI) : 0;
            bool engineer = torso == Detail.Engineer;
            // the weapon rides the chest, bouncing a little with each step; the muzzle kicks up on a shot
            float carry = loco * (1f - aim);
            var weapon = torsoOrigin + math.rotate(chest, new float3(engineer ? .12f : .055f, .535f + .12f * aim + carry * .012f * Mathf.Sin(2f * g), .14f - recoil - recoil * .5f * kneel) * scale);
            var weaponTilt = math.mul(chest, quaternion.EulerZXY(.39f * (1f - aim) + reload * .12f - recoil * 1.6f + carry * .05f * Mathf.Sin(2f * g + .6f),
                -.13f * (1f - aim) + carry * .06f * Mathf.Sin(g), -.29f * (1f - aim) + reload * .20f));
            if ((equipment & 1) != 0)
            {
                var plate = torsoOrigin + math.rotate(chest, new float3(0, .63f, .105f) * scale);
                batches[(int)Model.Plate].Add(InstanceData.TRS(plate, chest, new float3(.22f, .19f, .037f) * scale, new float4(.34f, .38f, .29f, 0)));
            }
            if ((equipment & 16) != 0)
            {
                var radio = torsoOrigin + math.rotate(chest, new float3(-.14f, .75f, -.07f) * scale);
                batches[(int)Model.Plate].Add(InstanceData.TRS(radio, chest, new float3(.013f, .21f, .014f) * scale, new float4(.17f, .19f, .18f, 0)));
            }
            float3 forward = math.rotate(turn, new float3(0, 0, 1));
            for (int side = -1; side <= 1; side += 2)
            {
                var hip = root + math.rotate(turn, new float3(side * .072f, .454f, 0) * scale);
                var ankle = origin + math.rotate(turn, (side > 0 ? footR : footL) * scale);
                if (groundView.W > 0)
                {
                    float floor = groundView.GroundHeight(ankle.x, -ankle.z);
                    ankle.y += Mathf.Clamp(floor - q.Foot.y, -.07f * scale, .13f * scale);
                }
                float3 delta = ankle - hip;
                float length = math.clamp(math.length(delta), .13f * scale, .461f * scale);
                float3 down = math.normalizesafe(delta, new float3(0, -1, 0));
                float a = .245f * scale, b = .222f * scale;
                float along = (a * a - b * b + length * length) / (2 * length);
                float bend = Mathf.Sqrt(Mathf.Max(0, a * a - along * along));
                var knee = hip + down * along + math.normalizesafe(forward - down * math.dot(forward, down), forward) * bend;
                DetailPart(Detail.Thigh, hip, LimbRotation(turn, knee - hip), scale, q.Color);
                DetailPart(Detail.Shin, knee, LimbRotation(turn, ankle - knee), scale, q.Color);
                var shoulder = torsoOrigin + math.rotate(chest, new float3(side * .161f, .715f, .01f) * scale);
                float3 wrist;
                if (!engineer || aim > .25f && !assisting)
                {
                    var grip = side > 0 ? new float3(.006f, -.052f, -.045f) : new float3(-.014f, -.012f, .055f);
                    if (engineer) grip = new float3(side > 0 ? 0 : -.028f, -.035f, -.02f);
                    if (reload > 0 && side < 0) grip += new float3(-.03f, -.09f * reload, -.06f * reload);
                    wrist = weapon + math.rotate(weaponTilt, grip * scale);
                }
                else
                {
                    // free arms swing against the leg on the same side, higher and bent when running
                    float swing = -(side > 0 ? advR : advL) * Mathf.Lerp(.13f, .2f, run);
                    wrist = torsoOrigin + math.rotate(chest, new float3(side * .17f, assisting ? .49f : .43f + run * loco * .09f, assisting ? .19f : .02f + swing) * scale);
                }
                var armDelta = wrist - shoulder;
                float armLength = math.clamp(math.length(armDelta), .055f * scale, .305f * scale);
                var armDown = math.normalizesafe(armDelta, new float3(0, -1, 0));
                float upperLength = .155f * scale, lowerLength = .154f * scale;
                float armAlong = (upperLength * upperLength - lowerLength * lowerLength + armLength * armLength) / (2 * armLength);
                float armBend = math.sqrt(math.max(0, upperLength * upperLength - armAlong * armAlong));
                var outward = math.rotate(chest, new float3(side * .7f, -.6f, -.4f));
                var elbow = shoulder + armDown * armAlong + math.normalizesafe(outward - armDown * math.dot(outward, armDown)) * armBend;
                DetailPart(Detail.UpperArm, shoulder, LimbRotation(chest, elbow - shoulder), scale, q.Color);
                DetailPart(Detail.Forearm, elbow, LimbRotation(chest, wrist - elbow), scale, q.Color);
            }
            if (!engineer || !assisting)
            {
                details[(int)(engineer ? Detail.PistolWeapon : torso == Detail.AntiArmor ? Detail.LauncherWeapon : Detail.RifleWeapon)].Add(InstanceData.TRS(weapon, weaponTilt, new float3(scale), new float4(.72f, .74f, .69f, 0)));
            }
        }
    }
}
