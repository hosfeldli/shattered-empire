namespace SE.Runtime.Rendering
{
    // One terrain-radius unit represents approximately 25 metres. Keep human-scale
    // architecture and military equipment consistent even when silhouettes are stylized.
    public static class WorldScale
    {
        public const float MetresPerUnit = 25f;
        public const float Soldier = 1.75f / MetresPerUnit;
        public const float DoorHeight = 2.25f / MetresPerUnit;
        public const float DoorWidth = .95f / MetresPerUnit;
        public const float Storey = 3f / MetresPerUnit;
        public const float Vehicle = .235f;
    }
}
