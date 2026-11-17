using SE.Runtime.App;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The main menu's update strip (see <see cref="Updater"/>): hidden until an update is found, then
    /// "Update available — Update now / Later", a progress bar while downloading, verifying and unpacking,
    /// and a message with a link to the download page when the update can't be installed in place.
    /// Styled inline so it needs no stylesheet changes; it sits above the menu's footer.
    /// </summary>
    public sealed class UpdateBanner : VisualElement
    {
        static readonly Color Accent = new Color(0.886f, 0.714f, 0.376f);
        static readonly Color Text = new Color(0.91f, 0.886f, 0.824f);
        static readonly Color Dim = new Color(0.588f, 0.643f, 0.627f);
        static readonly Color Bad = new Color(0.949f, 0.455f, 0.376f);

        readonly Label title, detail;
        readonly VisualElement bar, barFill, buttons;

        /// <summary>Insert the banner into <paramref name="parent"/> before <paramref name="before"/> and start the startup check.</summary>
        public static UpdateBanner Attach(VisualElement parent, VisualElement before)
        {
            var b = new UpdateBanner();
            int i = before != null ? parent.IndexOf(before) : -1;
            if (i >= 0) parent.Insert(i, b); else parent.Add(b);
            Updater.StartupCheck();
            return b;
        }

        UpdateBanner()
        {
            name = "se-update-banner";
            style.flexShrink = 0;
            style.flexDirection = FlexDirection.Column;
            style.marginTop = 8;
            style.paddingLeft = 12; style.paddingRight = 12; style.paddingTop = 10; style.paddingBottom = 10;
            style.backgroundColor = new Color(0.118f, 0.157f, 0.169f, 0.96f);
            style.borderLeftWidth = 2; style.borderLeftColor = Accent;
            style.borderTopLeftRadius = 4; style.borderTopRightRadius = 4; style.borderBottomLeftRadius = 4; style.borderBottomRightRadius = 4;

            title = new Label { pickingMode = PickingMode.Ignore };
            title.style.fontSize = 14; title.style.color = Text; title.style.unityFontStyleAndWeight = FontStyle.Bold;
            title.style.marginLeft = 0; title.style.paddingLeft = 0; title.style.whiteSpace = WhiteSpace.Normal;
            Add(title);

            detail = new Label { pickingMode = PickingMode.Ignore };
            detail.style.fontSize = 12; detail.style.color = Dim; detail.style.whiteSpace = WhiteSpace.Normal;
            detail.style.marginLeft = 0; detail.style.paddingLeft = 0; detail.style.marginTop = 2;
            Add(detail);

            bar = new VisualElement { pickingMode = PickingMode.Ignore };
            bar.style.height = 6; bar.style.marginTop = 8;
            bar.style.backgroundColor = new Color(1f, 1f, 1f, 0.08f);
            bar.style.borderTopLeftRadius = 3; bar.style.borderTopRightRadius = 3; bar.style.borderBottomLeftRadius = 3; bar.style.borderBottomRightRadius = 3;
            barFill = new VisualElement { pickingMode = PickingMode.Ignore };
            barFill.style.height = Length.Percent(100); barFill.style.width = Length.Percent(0);
            barFill.style.backgroundColor = Accent;
            barFill.style.borderTopLeftRadius = 3; barFill.style.borderBottomLeftRadius = 3; barFill.style.borderTopRightRadius = 3; barFill.style.borderBottomRightRadius = 3;
            bar.Add(barFill);
            Add(bar);

            buttons = new VisualElement();
            buttons.style.flexDirection = FlexDirection.Row;
            buttons.style.marginTop = 8;
            Add(buttons);

            RegisterCallback<AttachToPanelEvent>(_ => { Updater.Changed += Refresh; Refresh(); });
            RegisterCallback<DetachFromPanelEvent>(_ => Updater.Changed -= Refresh);
            Refresh();
        }

        UnityEngine.UIElements.Button AddButton(string label, System.Action click, bool primary)
        {
            var b = UiKit.Button(label, click, buttons, null, "se-menu-action");
            b.style.marginLeft = buttons.childCount > 1 ? 8 : 0;
            if (primary) { b.style.borderLeftWidth = 2; b.style.borderLeftColor = Accent; }
            return b;
        }

        Updater.Phase shownPhase = (Updater.Phase)(-1);
        bool shownLink;

        void Refresh()
        {
            var p = Updater.State;
            bool visible = p == Updater.Phase.Available || p == Updater.Phase.Downloading || p == Updater.Phase.Verifying
                || p == Updater.Phase.Extracting || p == Updater.Phase.Installing || p == Updater.Phase.Failed;
            style.display = visible ? DisplayStyle.Flex : DisplayStyle.None;
            if (!visible) { shownPhase = p; return; }

            string size = Updater.AvailableSize > 0 ? $" · {Updater.AvailableSize / 1048576} MB" : "";
            string ver = string.IsNullOrEmpty(Updater.AvailableVersion) ? "" : "v" + Updater.AvailableVersion + " · ";
            bool busy = p == Updater.Phase.Downloading || p == Updater.Phase.Verifying || p == Updater.Phase.Extracting || p == Updater.Phase.Installing;
            title.text = p == Updater.Phase.Failed ? "Update not installed" : busy ? "Updating Shattered Empires" : "Update available";
            title.style.color = p == Updater.Phase.Failed ? Bad : Text;
            detail.text = p == Updater.Phase.Available
                ? $"{ver}build {Updater.AvailableBuild}{size} (you have {(string.IsNullOrEmpty(Updater.CurrentBuild) ? "an older build" : Updater.CurrentBuild)})"
                : Updater.Message;
            bar.style.display = busy ? DisplayStyle.Flex : DisplayStyle.None;
            barFill.style.width = Length.Percent(Mathf.Clamp01(Updater.Progress) * 100f);

            // rebuild the buttons only when the phase (or link offer) changes, not on every progress tick
            if (p == shownPhase && Updater.OfferDownloadPage == shownLink) return;
            shownPhase = p; shownLink = Updater.OfferDownloadPage;
            buttons.Clear();
            switch (p)
            {
                case Updater.Phase.Available:
                    AddButton("Update now", Updater.InstallNow, true);
                    AddButton("Later", Updater.Later, false);
                    break;
                case Updater.Phase.Downloading:
                    AddButton("Cancel", Updater.Cancel, false);
                    break;
                case Updater.Phase.Failed:
                    if (!string.IsNullOrEmpty(Updater.AvailableBuild)) AddButton("Try again", Updater.InstallNow, true);
                    if (Updater.OfferDownloadPage) AddButton("Download page", () => Application.OpenURL(Updater.DownloadPage), false);
                    AddButton("Dismiss", Updater.Later, false);
                    break;
            }
            buttons.style.display = buttons.childCount > 0 ? DisplayStyle.Flex : DisplayStyle.None;
        }
    }
}
