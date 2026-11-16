using UnityEditor;
using UnityEngine;

namespace SE.EditorTools
{
    sealed class TerrainMaterialImport : AssetPostprocessor
    {
        void OnPreprocessTexture()
        {
            bool grass = assetPath.EndsWith("/Textures/GroundGrass.jpg", System.StringComparison.Ordinal) || assetPath.EndsWith("/Textures/GroundGrassNormal.jpg", System.StringComparison.Ordinal);
            string name = System.IO.Path.GetFileName(assetPath);
            bool curated = name == "GroundEarth.jpg" || name == "GroundEarthNormal.jpg" || name == "UnitFabric.jpg" || name == "UnitFabricRoughness.jpg" || name == "UnitArmor.jpg" || name == "UnitArmorRoughness.jpg";
            bool normal = name == "GroundGrassNormal.jpg" || name == "GroundEarthNormal.jpg";
            if (!grass && !curated && !assetPath.EndsWith("/Resources/Textures/TerrainAtlas.png", System.StringComparison.Ordinal)
                && !assetPath.EndsWith("/Resources/Textures/ArchitectureAtlas.png", System.StringComparison.Ordinal)) return;
            var texture = (TextureImporter)assetImporter;
            texture.textureType = normal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            texture.sRGBTexture = !normal && !name.Contains("Roughness");
            texture.mipmapEnabled = true;
            texture.npotScale = TextureImporterNPOTScale.None;
            texture.wrapMode = TextureWrapMode.Repeat;
            texture.filterMode = FilterMode.Trilinear;
            texture.anisoLevel = 8;
            texture.maxTextureSize = curated ? 1024 : 2048;
            texture.textureCompression = TextureImporterCompression.CompressedHQ;
            texture.isReadable = false;
        }
    }
}
