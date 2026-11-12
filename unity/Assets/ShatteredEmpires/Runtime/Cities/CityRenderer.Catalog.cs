using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// The building catalogue (visual design bible §16): a recognisable silhouette for every building
    /// type that used to share a generic factory, mine or mast. Each says what it produces at a glance
    /// (furnaces and stacks, distillation columns and tanks, blast-separated halls, gantries, clean-room
    /// walls, hangars and launch pads, robot arms, headframes, quarry benches, wreck stacks, pumpjacks,
    /// emitter pylons, lattice masts, silo doors) and grows at level 2 and 3. All modules sit in the
    /// building's parcel frame, so they scale with the room the streets leave.
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        static readonly float3 SteelGrey = new float3(0.42f, 0.43f, 0.45f);
        static readonly float3 Dark = new float3(0.2f, 0.2f, 0.22f);
        static readonly float3 White = new float3(0.86f, 0.86f, 0.84f);
        static readonly float3 Glass = new float3(0.32f, 0.44f, 0.52f);
        static readonly float3 Earth = new float3(0.4f, 0.36f, 0.27f);

        // ------------------------------------------------------------------ placement ghost (bible §28)
        Cell ghost;
        string ghostKey;

        /// <summary>
        /// The building being placed, drawn at the site under the cursor exactly as it will be composed
        /// there (same recipe, same parcel), tinted green where it may go and red where it may not.
        /// </summary>
        public void SetGhost(string type, int tile, int owner, bool valid, SE.Core.Protocol.BaseParcel? parcel = null)
        {
            if (string.IsNullOrEmpty(type) || tile < 0 || !world.Ready) { ClearGhost(); return; }
            string key = type + "|" + tile + "|" + valid + "|" + Age + "|" + parcel?.X.ToString("F2") + "|" + parcel?.Z.ToString("F2");
            if (key == ghostKey) return;
            ghostKey = key;
            if (ghost == null) ghost = CreateCell(true);
            var keep = current;
            var keepStreets = streetGeometry;
            int keepStreetQuads = streetQuads;
            current = ghost;
            foreach (var b in ghost.Batches) b.Clear();
            BeginStreetMesh();
            bmin = new float3(1e9f); bmax = new float3(-1e9f);
            ComposeBuilding(new SE.Core.Protocol.BuildingRecord { Id = -1, Owner = owner, Type = type, Tile = tile, Hp = 100, Done = true, Progress = 100, Level = 1, Era = Age, State = "ok",
                HasPosition = parcel.HasValue, HasYaw = parcel.HasValue, X = parcel?.X ?? 0, Z = parcel?.Z ?? 0, Yaw = parcel?.Yaw ?? 0, Slot = parcel?.Id ?? 0 });
            FinishStreetMesh(ghost);
            current = keep;
            streetGeometry = keepStreets; streetQuads = keepStreetQuads;
            var tintTo = valid ? new float3(0.45f, 1f, 0.55f) : new float3(1f, 0.35f, 0.3f);
            var bounds = new Bounds();
            bounds.SetMinMax(new Vector3(bmin.x, bmin.y - 0.2f, bmin.z), new Vector3(bmax.x, bmax.y + 0.2f, bmax.z));
            foreach (var b in ghost.Batches)
            {
                for (int i = 0; i < b.Count; i++)
                {
                    var d = b.Data[i];
                    d.Color = new float4(math.lerp(d.Color.xyz, tintTo, 0.45f), 0.35f);
                    b.Data[i] = d;
                }
                b.Bounds = bounds; b.MarkDirty();
            }
            ghost.Any = true;
        }

        public void ClearGhost()
        {
            if (ghostKey == null) return;
            ghostKey = null;
            if (ghost != null) { foreach (var b in ghost.Batches) b.Clear(); ghost.Any = false; }
        }

        void DrawGhost(Rendering.WrapImages images)
        {
            if (ghost == null || !ghost.Any || ghostKey == null) return;
            foreach (var b in ghost.Batches) b.DrawImages(images);
            ghost.StreetBatch?.DrawImages(images);
        }

        /// <summary>Furnace halls, a blast furnace, tall stacks, a pipe rack and the ore stockyard; furnace glow at the doors.</summary>
        void SteelMill(in Ctx c)
        {
            var hall = c.Era >= 2 ? Rust(c.Seed) : Brick(c.Seed) * 0.9f;
            Module(c, Part.Box, -0.2f, -0.2f, new float3(0.8f, 0.3f, 0.36f), hall);
            Facade(c, -.2f, -.2f, .8f, .36f, .30f, 0, c.Seed, true);
            Module(c, Part.Roof, -0.2f, -0.2f, new float3(0.82f, 0.08f, 0.38f), Dark, 0, 0.3f);
            Module(c, Part.Box, -0.2f, -0.02f, new float3(0.16f, 0.1f, 0.01f), new float3(1f, 0.55f, 0.2f), 0, 0.02f, 1.6f);   // furnace glow
            Module(c, Part.Cylinder, 0.42f, -0.25f, new float3(0.2f, 0.5f, 0.2f), Dark * 1.3f);
            Module(c, Part.Cone, 0.42f, -0.25f, new float3(0.2f, 0.12f, 0.2f), Dark * 1.2f, 0, 0.5f);
            int stacks = 2 + (c.Level >= 2 ? 1 : 0);
            for (int k = 0; k < stacks; k++)
            {
                float h = 0.85f + Hash(c.Seed, k) * 0.25f;
                Module(c, Part.Chimney, -0.5f + k * 0.18f, -0.5f, new float3(0.07f, h, 0.07f), new float3(0.5f, 0.42f, 0.38f));
                Stack(c, -0.5f + k * 0.18f, -0.5f, h, false, 0.32f);
            }
            Module(c, Part.Box, 0.1f, 0.12f, new float3(0.8f, 0.03f, 0.03f), new float3(0.55f, 0.48f, 0.38f), 0, 0.18f);   // pipe rack
            for (int k = 0; k < 3; k++) Module(c, Part.Cone, -0.35f + k * 0.2f, 0.45f, new float3(0.2f, 0.1f, 0.2f), new float3(0.42f, 0.26f, 0.2f));   // ore
            if (c.Level >= 2) { Module(c, Part.Box, 0.35f, 0.3f, new float3(0.3f, 0.22f, 0.24f), hall * 0.95f); Module(c, Part.Roof, 0.35f, 0.3f, new float3(0.32f, 0.06f, 0.26f), Dark, 0, 0.22f); }
        }

        /// <summary>Distillation columns, a tank farm, pipe bridges, a control building and the flare.</summary>
        void Refinery(in Ctx c)
        {
            for (int k = 0; k < 3; k++)
            {
                float h = 0.55f + k * 0.15f + Hash(c.Seed, k) * 0.1f;
                Module(c, Part.Cylinder, -0.45f + k * 0.16f, -0.35f, new float3(0.09f, h, 0.09f), SteelGrey * (1f + k * 0.05f));
            }
            int tanks = 4 + (c.Level >= 2 ? 2 : 0);
            for (int k = 0; k < tanks; k++) Module(c, Part.Cylinder, 0.1f + (k % 3) * 0.2f, -0.1f + (k / 3) * 0.24f, new float3(0.17f, 0.11f, 0.17f), White * (0.95f + 0.05f * Hash(c.Seed, 10 + k)));
            Module(c, Part.Box, -0.15f, 0.05f, new float3(0.55f, 0.025f, 0.025f), new float3(0.6f, 0.55f, 0.4f), 0.4f, 0.2f);   // pipe bridge
            Module(c, Part.Box, -0.4f, 0.45f, new float3(0.22f, 0.12f, 0.18f), Concrete(c.Seed));   // control building
            Module(c, Part.Chimney, 0.6f, -0.55f, new float3(0.03f, 0.7f, 0.03f), new float3(0.6f, 0.6f, 0.6f));
            Module(c, Part.Box, 0.6f, -0.55f, new float3(0.04f, 0.06f, 0.04f), new float3(1f, 0.6f, 0.2f), 0, 0.7f, 2f);   // the flare
        }

        /// <summary>Secured production halls kept apart by earth berms, magazines under mounds, a guard tower.</summary>
        void Munitions(in Ctx c)
        {
            for (int k = 0; k < 3; k++)
            {
                float z = -0.5f + k * 0.45f;
                Module(c, Part.Box, -0.15f, z, new float3(0.6f, 0.14f, 0.2f), c.Era >= 2 ? Concrete(c.Seed + k) : Brick(c.Seed + k));
                Module(c, Part.Roof, -0.15f, z, new float3(0.62f, 0.05f, 0.22f), Olive * 0.9f, 0, 0.14f);
                if (k < 2) Module(c, Part.Box, -0.15f, z + 0.22f, new float3(0.66f, 0.06f, 0.06f), new float3(0.36f, 0.42f, 0.27f));   // blast berm
            }
            Module(c, Part.Dome, 0.5f, -0.35f, new float3(0.3f, 0.14f, 0.3f), new float3(0.38f, 0.44f, 0.28f));   // earth-covered magazine
            Module(c, Part.Box, 0.5f, -0.2f, new float3(0.08f, 0.06f, 0.02f), new float3(0.3f, 0.3f, 0.3f));
            for (int k = 0; k < 4; k++) Module(c, Part.Cylinder, 0.55f + (k % 2) * 0.06f, 0.45f + (k / 2) * 0.06f, new float3(0.01f, 0.26f, 0.01f), SteelGrey);
            Module(c, Part.Box, 0.58f, 0.48f, new float3(0.12f, 0.06f, 0.12f), Olive, 0, 0.26f);
        }

        /// <summary>A long assembly hall with roller doors, a dispatch yard of finished vehicles, a test loop.</summary>
        void MotorWorks(in Ctx c)
        {
            var wall = c.Era >= 2 ? Rust(c.Seed) * 1.05f : Brick(c.Seed);
            Module(c, Part.Box, 0, -0.25f, new float3(1.0f, 0.24f, 0.4f), wall);
            for (int t = 0; t < 5; t++) Module(c, Part.Roof, -0.4f + t * 0.2f, -0.25f, new float3(0.2f, 0.07f, 0.4f), t % 2 == 0 ? Dark : Glass, 1.5708f, 0.24f);
            for (int d = 0; d < 4; d++)
            {
                float x = -.36f + d * .24f;
                Module(c, Part.Concrete, x, -.045f, new float3(.17f, .172f, .012f), new float3(.62f, .61f, .57f));
                Module(c, Part.Siding, x, -.034f, new float3(.14f, .14f, .015f), new float3(.32f, .36f, .38f));
                Module(c, Part.Glass, x, -.035f, new float3(.11f, .039f, .014f), new float3(.40f, .53f, .57f), 0, .186f);
            }
            Module(c, Part.Box, 0, 0.35f, new float3(0.95f, 0.01f, 0.38f), new float3(0.36f, 0.36f, 0.37f));
            int rows = c.Level >= 2 ? 3 : 2;
            for (int r = 0; r < rows; r++)
                for (int k = 0; k < 5; k++)
                    if (Hash(c.Seed, 30 + r * 5 + k) < 0.75f) Parked(c, -0.36f + k * 0.18f, 0.22f + r * 0.12f, 0f, c.Seed + r * 5 + k, r == 0);
        }

        /// <summary>An oversized hall with high doors and a gantry crane spanning the heavy yard.</summary>
        void HeavyAssembly(in Ctx c)
        {
            var wall = c.Era >= 3 ? new float3(0.52f, 0.55f, 0.58f) : Rust(c.Seed);
            Module(c, Part.Box, -0.15f, -0.2f, new float3(0.85f, 0.42f, 0.5f), wall);
            BarrelRoof(c, -0.15f, -0.2f, 0.85f, 0.5f, 0.42f, new float3(0.38f, 0.39f, 0.41f));
            Module(c, Part.Box, -0.15f, 0.06f, new float3(0.3f, 0.32f, 0.01f), Dark);   // the high door
            // the gantry: two legs and a beam across the yard
            for (int s = -1; s <= 1; s += 2) Module(c, Part.Box, -0.15f + s * 0.4f, 0.42f, new float3(0.035f, 0.42f, 0.035f), Hazard);
            Module(c, Part.Box, -0.15f, 0.42f, new float3(0.86f, 0.04f, 0.05f), Hazard, 0, 0.42f);
            Module(c, Part.Box, -0.15f + (Hash(c.Seed, 3) - 0.5f) * 0.5f, 0.42f, new float3(0.06f, 0.04f, 0.06f), Dark, 0, 0.38f);
            if (c.Level >= 2) Module(c, Part.Box, 0.5f, 0.1f, new float3(0.2f, 0.06f, 0.1f), Olive);   // a hull awaiting fitting
        }

        /// <summary>Clean pale walls with a glazed band, roof air handling and solar panels, a quiet loading dock.</summary>
        void Electronics(in Ctx c)
        {
            Module(c, Part.Box, -0.1f, -0.15f, new float3(0.8f, 0.2f, 0.5f), White);
            Module(c, Part.Box, -0.1f, 0.105f, new float3(0.78f, 0.05f, 0.01f), Glass, 0, 0.1f, 0.3f);   // glazing
            for (int k = 0; k < 4; k++) Module(c, Part.Box, -0.4f + k * 0.2f, -0.25f, new float3(0.08f, 0.05f, 0.08f), SteelGrey, 0, 0.2f);   // air handling
            for (int k = 0; k < 3; k++) Module(c, Part.Box, -0.25f + k * 0.2f, -0.02f, new float3(0.16f, 0.008f, 0.1f), new float3(0.12f, 0.16f, 0.3f), 0, 0.2f);   // solar
            Module(c, Part.Box, 0.45f, 0.35f, new float3(0.26f, 0.08f, 0.16f), White * 0.92f);
            if (c.Level >= 2) Module(c, Part.Box, -0.5f, 0.42f, new float3(0.3f, 0.16f, 0.24f), White * 0.96f);
        }

        /// <summary>Twin hangars, launch pads, a radar on its mast and the control building.</summary>
        void DroneWorks(in Ctx c)
        {
            for (int k = 0; k < 2; k++)
            {
                Module(c, Part.Box, -0.35f + k * 0.42f, -0.3f, new float3(0.34f, 0.1f, 0.36f), new float3(0.5f, 0.52f, 0.5f));
                BarrelRoof(c, -0.35f + k * 0.42f, -0.3f, 0.36f, 0.34f, 0.1f, new float3(0.46f, 0.48f, 0.47f));
            }
            int pads = 2 + (c.Level >= 2 ? 1 : 0);
            for (int k = 0; k < pads; k++)
            {
                Module(c, Part.Cylinder, -0.35f + k * 0.3f, 0.35f, new float3(0.2f, 0.01f, 0.2f), new float3(0.32f, 0.32f, 0.34f));
                Module(c, Part.Box, -0.35f + k * 0.3f, 0.35f, new float3(0.1f, 0.003f, 0.015f), new float3(0.85f, 0.8f, 0.3f), 0, 0.01f);
            }
            Module(c, Part.Cylinder, 0.55f, 0.1f, new float3(0.02f, 0.3f, 0.02f), SteelGrey);
            ModuleRot(c, Part.Dome, 0.55f, 0.1f, new float3(0.14f, 0.06f, 0.14f), White, 0.6f, 0f, 0.7f, 0.3f);   // radar
            Module(c, Part.Box, 0.5f, -0.5f, new float3(0.2f, 0.12f, 0.16f), Concrete(c.Seed));
        }

        /// <summary>A sleek automated hall with skylights, robot arms working the yard and conveyors.</summary>
        void Robotics(in Ctx c)
        {
            var wall = new float3(0.5f, 0.55f, 0.6f);
            Module(c, Part.Box, -0.1f, -0.25f, new float3(0.9f, 0.24f, 0.4f), wall);
            for (int k = 0; k < 4; k++) Module(c, Part.Box, -0.42f + k * 0.21f, -0.25f, new float3(0.1f, 0.01f, 0.34f), Glass, 0, 0.24f, 0.3f);
            Module(c, Part.Box, -0.1f, 0.2f, new float3(0.8f, 0.03f, 0.06f), Dark, 0, 0.05f);   // conveyor
            int arms = 3 + (c.Level >= 2 ? 1 : 0);
            for (int k = 0; k < arms; k++)
            {
                float x = -0.4f + k * 0.22f;
                Module(c, Part.Cylinder, x, 0.32f, new float3(0.05f, 0.05f, 0.05f), Hazard);
                ModuleRot(c, Part.Box, x, 0.32f, new float3(0.02f, 0.14f, 0.02f), Hazard, 0.5f, 0f, Hash(c.Seed, k) * 3f, 0.05f);
            }
        }

        /// <summary>A mine: shaft headframe with its wheel, the winding house, a conveyor, ore heaps and a haul truck.</summary>
        void Mine(in Ctx c)
        {
            var steel = c.Era == 0 ? Timber(c.Seed) : new float3(0.44f, 0.3f, 0.24f);
            for (int s = -1; s <= 1; s += 2) ModuleRot(c, Part.Box, -0.2f + s * 0.08f, -0.1f, new float3(0.03f, 0.55f, 0.03f), steel, 0f, -s * 0.18f);
            ModuleRot(c, Part.Box, -0.2f, 0.05f, new float3(0.03f, 0.55f, 0.03f), steel, 0.45f, 0f);
            ModuleRot(c, Part.Cylinder, -0.2f, -0.1f, new float3(0.14f, 0.02f, 0.14f), Dark, 1.5708f, 0f, 0f, 0.52f);   // the winding wheel
            Module(c, Part.Box, 0.25f, -0.25f, new float3(0.3f, 0.16f, 0.22f), c.Era == 0 ? Sheet(c.Seed) : Brick(c.Seed));
            ModuleRot(c, Part.Box, 0.2f, 0.25f, new float3(0.05f, 0.5f, 0.05f), Dark, 1.2f, 0f, 0.4f, 0.02f);   // conveyor
            for (int k = 0; k < 3; k++) Module(c, Part.Cone, 0.4f + k * 0.12f, 0.45f, new float3(0.22f, 0.12f + Hash(c.Seed, k) * 0.05f, 0.22f), new float3(0.32f, 0.27f, 0.24f));
            if (c.Era >= 1) Parked(c, -0.45f, 0.4f, 0.5f, c.Seed + 9, true);
        }

        /// <summary>A quarry: terraced benches cut into the ground, a crusher, a conveyor and aggregate piles.</summary>
        void Quarry(in Ctx c)
        {
            var rock = new float3(0.6f, 0.57f, 0.5f);
            for (int k = 0; k < 3; k++) Module(c, Part.Box, -0.25f, -0.2f + k * 0.08f, new float3(0.7f - k * 0.16f, 0.06f, 0.5f - k * 0.12f), rock * (1f - k * 0.08f), 0, -0.05f * k);
            Module(c, Part.Box, 0.45f, -0.3f, new float3(0.18f, 0.2f, 0.16f), new float3(0.5f, 0.45f, 0.36f));   // crusher
            ModuleRot(c, Part.Box, 0.45f, 0f, new float3(0.04f, 0.45f, 0.04f), Dark, 1.25f, 0f, 0f, 0.05f);
            for (int k = 0; k < 3; k++) Module(c, Part.Cone, 0.3f + k * 0.14f, 0.45f, new float3(0.2f, 0.12f, 0.2f), rock * (0.85f + 0.1f * k));
            if (c.Level >= 2) Parked(c, -0.4f, 0.45f, 0.3f, c.Seed + 4, true);
        }

        /// <summary>A salvage yard: fenced compound, stacks of wrecks, a sorting hall and the yard crane.</summary>
        void Salvage(in Ctx c)
        {
            Module(c, Part.Box, -0.3f, -0.35f, new float3(0.45f, 0.16f, 0.26f), c.Era == 0 ? Sheet(c.Seed) : Rust(c.Seed));
            for (int k = 0; k < 6; k++)
            {
                float a = Hash(c.Seed, 50 + k) * 6.28f, r = 0.2f + Hash(c.Seed, 60 + k) * 0.35f;
                Module(c, Part.Box, 0.15f + Mathf.Cos(a) * r * 0.6f, 0.15f + Mathf.Sin(a) * r * 0.6f, new float3(0.1f, 0.035f, 0.06f), new float3(0.32f, 0.26f, 0.22f) * (0.8f + 0.4f * Hash(c.Seed, k)), a, (k % 3) * 0.035f);
            }
            Module(c, Part.Crane, 0.45f, -0.35f, new float3(0.45f, 0.45f, 0.45f), new float3(0.7f, 0.55f, 0.25f), Hash(c.Seed, 3) * 3f);
            for (int k = 0; k < 4; k++) { float a = k * 1.5708f; Module(c, Part.Box, Mathf.Cos(a) * 0.68f, Mathf.Sin(a) * 0.68f, new float3(k % 2 == 0 ? 0.01f : 1.3f, 0.04f, k % 2 == 0 ? 1.3f : 0.01f), SteelGrey); }
        }

        /// <summary>A timber mill: open saw shed, log decks, a conveyor and stacked sawn timber.</summary>
        void TimberMill(in Ctx c)
        {
            for (int k = 0; k < 6; k++) Module(c, Part.Cylinder, -0.4f + (k % 3) * 0.3f, -0.3f + (k / 3) * 0.3f, new float3(0.02f, 0.16f, 0.02f), Timber(c.Seed + k));
            Module(c, Part.Box, -0.1f, -0.15f, new float3(0.68f, 0.012f, 0.4f), c.Era == 0 ? Sheet(c.Seed) : new float3(0.36f, 0.38f, 0.4f), 0, 0.16f);
            for (int k = 0; k < 5; k++) ModuleRot(c, Part.Cylinder, 0.45f, 0.25f + (k % 3) * 0.06f, new float3(0.05f, 0.4f, 0.05f), new float3(0.48f, 0.36f, 0.24f), 0f, 1.5708f, 0f, 0.025f + (k / 3) * 0.05f);
            for (int k = 0; k < 2; k++) Module(c, Part.Box, -0.4f + k * 0.25f, 0.45f, new float3(0.18f, 0.08f, 0.1f), new float3(0.66f, 0.54f, 0.38f));
            Module(c, Part.Box, 0.1f, 0.2f, new float3(0.4f, 0.02f, 0.04f), Dark, 0.3f, 0.06f);
        }

        /// <summary>An oil well: the pumpjack (frame, walking beam, horsehead), storage tanks and pipes.</summary>
        void PumpJack(in Ctx c)
        {
            var frame = new float3(0.36f, 0.36f, 0.38f);
            Module(c, Part.Box, 0, 0, new float3(0.42f, 0.03f, 0.12f), new float3(0.4f, 0.4f, 0.4f));
            for (int s = -1; s <= 1; s += 2) ModuleRot(c, Part.Box, 0.05f, s * 0.03f, new float3(0.025f, 0.26f, 0.025f), frame, s * 0.15f, 0f);
            // the walking beam rocks: its tilt is stable per well, as if caught mid-stroke
            float tilt = (Hash(c.Seed, 4) - 0.5f) * 0.4f;
            ModuleRot(c, Part.Box, 0.05f, 0, new float3(0.025f, 0.025f, 0.45f), Hazard, tilt, 0f, 0f, 0.25f);
            Module(c, Part.Box, -0.17f, 0, new float3(0.05f, 0.08f, 0.06f), Hazard, 0, 0.2f);   // horsehead
            for (int k = 0; k < 2; k++) Module(c, Part.Cylinder, 0.45f, -0.3f + k * 0.22f, new float3(0.16f, 0.16f, 0.16f), White * 0.9f);
            Module(c, Part.Box, 0.25f, -0.2f, new float3(0.4f, 0.015f, 0.015f), new float3(0.55f, 0.5f, 0.4f), 0.5f, 0.03f);
        }

        /// <summary>A shield generator: the central emitter on its plinth, four pylons, conduits and a faint operating ring.</summary>
        void ShieldGenerator(in Ctx c)
        {
            Module(c, Part.Cylinder, 0, 0, new float3(0.3f, 0.06f, 0.3f), new float3(0.5f, 0.5f, 0.52f));
            Module(c, Part.Cylinder, 0, 0, new float3(0.1f, 0.5f, 0.1f), new float3(0.62f, 0.64f, 0.68f), 0, 0.06f);
            Module(c, Part.Dome, 0, 0, new float3(0.16f, 0.12f, 0.16f), new float3(0.55f, 0.75f, 0.95f), 0, 0.56f, 0.8f);
            for (int k = 0; k < 4; k++)
            {
                float a = k * 1.5708f + 0.785f;
                Module(c, Part.Box, Mathf.Cos(a) * 0.45f, Mathf.Sin(a) * 0.45f, new float3(0.05f, 0.32f, 0.05f), new float3(0.5f, 0.52f, 0.56f));
                Module(c, Part.Box, Mathf.Cos(a) * 0.45f, Mathf.Sin(a) * 0.45f, new float3(0.07f, 0.03f, 0.07f), new float3(0.5f, 0.8f, 1f), 0, 0.32f, 0.9f);
                Module(c, Part.Box, Mathf.Cos(a) * 0.22f, Mathf.Sin(a) * 0.22f, new float3(0.02f, 0.015f, 0.45f), Dark, a + 1.5708f, 0.01f);   // conduit
            }
            Module(c, Part.Cylinder, 0, 0, new float3(1.0f, 0.004f, 1.0f), new float3(0.45f, 0.7f, 1f), 0, 0.012f, 0.35f);   // the operating ring
        }

        /// <summary>A communications tower: a tapering lattice mast with braces, antennas, a dish and the red beacon.</summary>
        void LatticeMast(in Ctx c)
        {
            float h = 1.3f + (c.Level - 1) * 0.2f;
            var red = new float3(0.75f, 0.3f, 0.26f);
            for (int k = 0; k < 4; k++)
            {
                float a = k * 1.5708f + 0.785f;
                ModuleRot(c, Part.Box, Mathf.Cos(a) * 0.07f, Mathf.Sin(a) * 0.07f, new float3(0.012f, h, 0.012f), k % 2 == 0 ? red : White, -Mathf.Sin(a) * 0.04f, Mathf.Cos(a) * 0.04f);
            }
            for (int f = 1; f < 6; f++) Module(c, Part.Box, 0, 0, new float3(0.14f - f * 0.018f, 0.008f, 0.14f - f * 0.018f), f % 2 == 0 ? red : White, 0.785f, f * h / 6f);
            ModuleRot(c, Part.Dome, 0.05f, 0, new float3(0.12f, 0.04f, 0.12f), White, 1.2f, 0f, 0f, h * 0.65f);
            for (int k = 0; k < 3; k++) Module(c, Part.Box, 0, 0, new float3(0.006f, 0.12f, 0.006f), SteelGrey, k, h);
            Module(c, Part.Box, 0, 0, new float3(0.03f, 0.03f, 0.03f), new float3(1f, 0.2f, 0.15f), 0, h + 0.1f, 2f);   // beacon
            Module(c, Part.Box, 0.3f, 0.2f, new float3(0.26f, 0.14f, 0.2f), Concrete(c.Seed));   // equipment shelter
            if (c.Level >= 2) ModuleRot(c, Part.Dome, 0.35f, 0.2f, new float3(0.1f, 0.03f, 0.1f), White, 0.8f, 0f, 2f, 0.16f);
        }

        /// <summary>A missile silo: the reinforced pad with its armoured doors, the service block, perimeter and warning light.</summary>
        void MissileSilo(in Ctx c)
        {
            var conc = new float3(0.5f, 0.5f, 0.47f);
            Module(c, Part.Cylinder, 0, 0, new float3(0.5f, 0.05f, 0.5f), conc);
            for (int s = -1; s <= 1; s += 2) Module(c, Part.Box, s * 0.07f, 0, new float3(0.13f, 0.03f, 0.3f), new float3(0.32f, 0.33f, 0.31f), 0, 0.05f);   // the doors
            Module(c, Part.Box, 0, 0.18f, new float3(0.012f, 0.009f, 0.012f), new float3(.45f, .035f, .018f), 0, 0.07f, .02f);   // dim warning lens
            Module(c, Part.Box, 0.45f, 0.35f, new float3(0.3f, 0.14f, 0.24f), conc * 0.95f);
            Module(c, Part.Box, -0.45f, 0.4f, new float3(0.14f, 0.1f, 0.14f), conc * 0.9f);
            for (int k = 0; k < 4; k++) { float a = k * 1.5708f; Module(c, Part.Box, Mathf.Cos(a) * 0.7f, Mathf.Sin(a) * 0.7f, new float3(k % 2 == 0 ? 0.01f : 1.4f, 0.05f, k % 2 == 0 ? 1.4f : 0.01f), SteelGrey); }
        }

        /// <summary>A fortress: a stepped hardened command block, casemates at the corners and earth berms.</summary>
        void Fortress(in Ctx c)
        {
            var conc = new float3(0.52f, 0.51f, 0.48f);
            Module(c, Part.Box, 0, 0, new float3(0.6f, 0.18f, 0.5f), conc);
            Module(c, Part.Box, 0, 0, new float3(0.38f, 0.12f, 0.3f), conc * 0.95f, 0, 0.18f);
            Module(c, Part.Box, 0, -0.05f, new float3(0.06f, 0.2f, 0.06f), SteelGrey, 0, 0.3f);   // the command mast
            for (int k = 0; k < 4; k++)
            {
                float sx = k % 2 == 0 ? -0.5f : 0.5f, sz = k < 2 ? -0.45f : 0.45f;
                Module(c, Part.Box, sx, sz, new float3(0.18f, 0.1f, 0.16f), conc * 0.9f);
                Module(c, Part.Box, sx, sz + (sz > 0 ? 0.08f : -0.08f), new float3(0.1f, 0.015f, 0.01f), Dark, 0, 0.05f);   // firing slit
            }
            for (int k = 0; k < 4; k++) { float a = k * 1.5708f; Module(c, Part.Box, Mathf.Cos(a) * 0.72f, Mathf.Sin(a) * 0.72f, new float3(k % 2 == 0 ? 0.1f : 1.3f, 0.07f, k % 2 == 0 ? 1.3f : 0.1f), new float3(0.42f, 0.4f, 0.3f)); }
            Flag(c, 0.12f, 0.12f, 0.55f);
        }
    }
}
