using System.IO;
using UnityEditor;
using UnityEngine;

namespace SE.EditorTools
{
    /// <summary>
    /// Import rules for Resources/Workshop (media converted by tools/ingest-workshop-assets.cjs from the
    /// owner's Asset Store downloads; git-ignored). Texture overrides keep the name of the committed
    /// texture they replace, so the curated rules in TerrainMaterialImport also recognise them.
    /// </summary>
    sealed class WorkshopImport : AssetPostprocessor
    {
        const string Root = "/Resources/Workshop/";

        void OnPreprocessTexture()
        {
            if (!assetPath.Contains(Root)) return;
            var t = (TextureImporter)assetImporter;
            string name = Path.GetFileNameWithoutExtension(assetPath);
            bool normal = name.EndsWith("Normal");
            bool data = normal || name.Contains("Roughness");
            bool sky = assetPath.Contains(Root + "Sky/");
            bool card = name.StartsWith("Blood") || name.StartsWith("GrassCard") || name.StartsWith("FlowerCard");
            t.textureType = normal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            t.sRGBTexture = !data;
            t.mipmapEnabled = true;
            t.npotScale = TextureImporterNPOTScale.None;
            t.filterMode = FilterMode.Trilinear;
            t.anisoLevel = sky ? 2 : 8;
            t.isReadable = false;
            t.textureCompression = TextureImporterCompression.CompressedHQ;
            if (sky)
            {
                // Equirectangular panoramas: wrap around the horizon, clamp at the poles.
                t.wrapModeU = TextureWrapMode.Repeat;
                t.wrapModeV = TextureWrapMode.Clamp;
                t.maxTextureSize = 4096;
                t.mipmapEnabled = false;
            }
            else if (card)
            {
                t.alphaSource = TextureImporterAlphaSource.FromInput;
                t.alphaIsTransparency = true;
                t.mipMapsPreserveCoverage = true;
                t.alphaTestReferenceValue = .35f;
                t.wrapMode = TextureWrapMode.Clamp;
                t.maxTextureSize = 512;
            }
            else
            {
                t.wrapMode = TextureWrapMode.Repeat;
                t.maxTextureSize = name.EndsWith("Atlas") ? 2048 : 1024;
            }
        }

        void OnPreprocessAudio()
        {
            if (!assetPath.Contains(Root)) return;
            var importer = (AudioImporter)assetImporter;
            string name = Path.GetFileNameWithoutExtension(assetPath);
            bool music = name.StartsWith("music_");
            bool bed = name.StartsWith("amb_");
            // One-shots were converted to mono; music and beds keep their stereo image.
            importer.forceToMono = false;
            importer.loadInBackground = music || bed;
            var s = importer.defaultSampleSettings;
            s.preloadAudioData = !music;
            s.loadType = music ? AudioClipLoadType.Streaming : bed ? AudioClipLoadType.CompressedInMemory : AudioClipLoadType.DecompressOnLoad;
            s.compressionFormat = AudioCompressionFormat.Vorbis;
            s.quality = music ? .72f : .82f;
            s.sampleRateSetting = AudioSampleRateSetting.PreserveSampleRate;
            importer.defaultSampleSettings = s;
        }

        public override uint GetVersion() => 1;
    }
}
