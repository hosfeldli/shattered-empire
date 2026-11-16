using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The field guide: how the game works, searchable, with the sound and music credits at the end.
    /// One component for the main menu and the pause menu. It fills its parent (flex-grow 1); only the
    /// topic list scrolls.
    /// </summary>
    public static class FieldGuide
    {
        /// <summary>The action RTS ruleset (wheels, defense bar, bases with sockets).</summary>
        static readonly (string topic, string text)[] ActionTopics =
        {
            ("Scout and capture", "Move infantry or engineers into a ruin’s command zone. Hostile ground troops contest it, and progress decays if the zone is abandoned. Once it is secured, click it and choose Establish base."),
            ("Your base", "Click your headquarters to open the base wheel. Its eight wedges point at the building sites around the base: click a glowing empty site to choose a facility. The hub upgrades the base tier, which unlocks more sites. Technology unlocked at any base is available faction-wide."),
            ("Production", "Click a production building to open its wheel. Click a unit to queue it, Shift+click queues five, right-click cancels one and Ctrl+click repeats production. Double-click a building to select every one of its type on screen and share one order. Queued units reserve command capacity until they deploy or you cancel."),
            ("Materials and Energy", "Ground troops collect material drops on contact, without a return trip. Capture abandoned energy plants for extra Energy. Materials Processors and Energy Generators add passive income. The top bar shows each resource with its average income per second; click a resource for the breakdown."),
            ("Command an army", "Box-select or double-click similar units. Right-click to move, capture or attack; Shift queues the order. T attack-moves, H holds and X withdraws. Press C for the unit command wheel: abilities, air missions and digging in. Ctrl+1–9 saves a group and 1–9 recalls it."),
            ("Command wheels", "Every wheel works the same way. The panel below it describes the wedge under the pointer: cost, time and why it is locked. Digits 1–8 pick wedges clockwise from twelve o’clock while the pointer is over the wheel, and 0 shows more. Escape goes back one ring, then closes the wheel."),
            ("Draw a battle line", "Right-drag to deploy ground units along the terrain. Infantry take the front; vehicles and artillery deploy behind them. F flips the facing, Alt makes it an advancing line and Shift queues it."),
            ("Combined arms", "Infantry capture objectives and benefit from cover. Anti-armor teams counter vehicles. Artillery threatens clustered defenses. Aircraft need room to operate around air defense."),
            ("Defenses, roads and trenches", "The bar at the bottom of the screen builds field defenses anywhere on visible, legal ground; no base is needed. Press B and then a digit to pick one quickly; Q and E rotate a defense before you place it. Roads and trenches are drawn as routes. Engineers are optional: they assist construction and repair nearby when out of combat."),
            ("Rally and reinforcements", "Rally, on a base or building wheel, sets where new units gather. Reinforce group sends a building’s new units straight to one of your control groups."),
            ("Military Domination", "Destroy opposing headquarters and prevent their recovery. A faction with a recovery window can reclaim a ruin and reestablish command."),
            ("Camera and shortcuts", "WASD pans, middle-drag moves the camera and the mouse wheel zooms toward the cursor. Click the round minimap to jump there; right-click it to send the selected units. Space jumps to the latest alert. Every shortcut can be changed in Settings."),
        };

        /// <summary>The legacy strategic ruleset.</summary>
        static readonly (string topic, string text)[] LegacyTopics =
        {
            ("Camera", "W A S D or the arrow keys pan (Shift is faster); the mouse wheel zooms toward the cursor; middle-drag drags the map; Q and E turn. Double-click open ground to centre there; Backspace returns to the previous view; Space jumps to the latest alert."),
            ("Selecting", "Click a unit, or drag a box. Shift adds to the selection; double-click selects every unit of that type on screen. Ctrl+1–9 stores a group, 1–9 recalls it, and pressing it twice brings the camera there."),
            ("Orders", "Right-click moves. T then a click attack-moves. H holds, X withdraws. F follows the selection with the camera."),
            ("Battle lines", "Right-drag across the map to draw a line: you see where every unit will stand before you let go. F flips the facing, Alt makes it an advancing line, Shift queues it after current orders, Esc cancels."),
            ("Building", "Open Build (B), pick a building and click a highlighted site; drag to place several. Roads, bridges and trenches are drawn as routes. Sites wait for materials if you can't afford them yet."),
            ("Cities and mayors", "Select a town to see its people, homes and jobs. Guide Growth tells the mayor what to build next and where; the mayor never spends what you reserved for your own projects."),
            ("Resources", "Hover any resource at the top to see what produces it, what uses it, and what to do when it runs short. Power, people and the next era are always in view."),
            ("Research", "Open Research (R). Click an available technology to start it, Shift+click to queue it with everything it needs. Search finds technologies by what they unlock; hover one to see where it leads."),
            ("Eras", "Five eras: Reclamation, Industrial Recovery, Mechanization, Networked Warfare and Advanced Systems. Buildings keep the style of the era they were built in; upgrading brings them up to date."),
            ("Units", "Infantry (militia, rifle squads, engineers, mortars, special forces, exo infantry), vehicles (scout buggies, armoured cars, tanks, autonomous tanks, field guns, self-propelled artillery, air defence, missile batteries) and aircraft (fighters, bombers, helicopters, drones, strike swarms)."),
            ("Battlefields", "Fighting leaves its mark: craters, mud, wrecks and ruins stay. Trenches dug into the ground protect infantry; they join the bunkers and forts beside them."),
            ("Alerts", "Critical alerts interrupt with a banner; important ones appear as small notices with a Go button; everything else is written in the Chronicle (Overview). Concluded battles get a result card."),
            ("Settings", "Interface scale, reduced motion, screen shake, weather intensity, high-contrast markers, camera speed and every shortcut can be changed in Settings."),
        };

        /// <summary>The guide for the given ruleset; fills its parent.</summary>
        public static VisualElement Build(bool actionRts) => Build(actionRts, false);

        /// <summary>The guide; <paramref name="openCredits"/> opens the sound and music credits and scrolls to them.</summary>
        public static VisualElement Build(bool actionRts, bool openCredits)
        {
            var host = new VisualElement();
            host.AddToClassList("se-guide");
            host.style.flexGrow = 1;
            host.style.flexShrink = 1;
            host.style.minHeight = 0;

            var search = new TextField();
            search.AddToClassList("field");
            search.AddToClassList("se-menu-field");
            search.AddToClassList("se-guide-search");
            search.textEdition.placeholder = "Search the guide…";
            host.Add(search);

            var scroll = new ScrollView(ScrollViewMode.Vertical)
            {
                horizontalScrollerVisibility = ScrollerVisibility.Hidden,
                verticalScrollerVisibility = ScrollerVisibility.Auto,
                mouseWheelScrollSize = 38,
            };
            scroll.AddToClassList("bounded-scroll");
            scroll.AddToClassList("se-guide-scroll");
            scroll.style.flexGrow = 1;
            scroll.style.flexShrink = 1;
            scroll.style.minHeight = 0;
            host.Add(scroll);

            var entries = new List<(VisualElement el, string text)>();
            foreach (var (topic, text) in actionRts ? ActionTopics : LegacyTopics)
            {
                var item = new VisualElement();
                item.AddToClassList("se-guide-entry");
                var heading = new Label(topic);
                heading.AddToClassList("se-guide-topic");
                item.Add(heading);
                var body = new Label(text);
                body.AddToClassList("se-guide-text");
                body.style.whiteSpace = WhiteSpace.Normal;
                item.Add(body);
                scroll.Add(item);
                entries.Add((item, (topic + " " + text).ToLowerInvariant()));
            }

            var empty = new Label("Nothing in the guide matches that.");
            empty.AddToClassList("se-guide-text");
            empty.style.display = DisplayStyle.None;
            scroll.Add(empty);

            Foldout credits = null;
            var creditText = Resources.Load<TextAsset>("Audio/Credits");
            if (creditText != null)
            {
                credits = new Foldout { text = "Sound and music credits", value = openCredits };
                credits.AddToClassList("se-guide-credits");
                var body = new Label(creditText.text);
                body.AddToClassList("se-guide-text");
                body.style.whiteSpace = WhiteSpace.Normal;
                credits.Add(body);
                scroll.Add(credits);
                if (openCredits)
                {
                    var target = credits;
                    scroll.schedule.Execute(() => scroll.ScrollTo(target)).ExecuteLater(50);
                }
            }

            search.RegisterValueChangedCallback(e =>
            {
                string q = (e.newValue ?? "").Trim().ToLowerInvariant();
                int shown = 0;
                foreach (var (el, text) in entries)
                {
                    bool on = q.Length == 0 || text.Contains(q);
                    el.style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
                    if (on) shown++;
                }
                empty.style.display = shown == 0 ? DisplayStyle.Flex : DisplayStyle.None;
                if (credits != null) credits.style.display = q.Length == 0 || "sound music credits".Contains(q) ? DisplayStyle.Flex : DisplayStyle.None;
            });
            return host;
        }
    }
}
