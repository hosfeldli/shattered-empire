using UnityEditor;
using UnityEngine;

namespace SE.EditorTools
{
    sealed class TerrainMaterialImport : AssetPostprocessor
    {
        void OnPreprocessTexture()
        {
            bool grass = assetPath.EndsWith("/Textures/GroundGrass.jpg", System.StringComparison.Ordinal) || assetPath.EndsWith("/Textures/GroundGrassNormal.jpg", System.StringComparison.Ordinal);
            bool normal = assetPath.EndsWith("GroundGrassNormal.jpg", System.StringComparison.Ordinal);
            if (!grass && !assetPath.EndsWith("/Resources/Textures/TerrainAtlas.png", System.StringComparison.Ordinal)
                && !assetPath.EndsWith("/Resources/Textures/ArchitectureAtlas.png", System.StringComparison.Ordinal)) return;
            var texture = (TextureImporter)assetImporter;
            texture.textureType = normal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            texture.sRGBTexture = !normal;
            texture.mipmapEnabled = true;
            texture.npotScale = TextureImporterNPOTScale.None;
            texture.wrapMode = TextureWrapMode.Repeat;
            texture.filterMode = FilterMode.Trilinear;
            texture.anisoLevel = 8;
            texture.maxTextureSize = 2048;
            texture.textureCompression = TextureImporterCompression.CompressedHQ;
            texture.isReadable = false;
        }
    }
}
