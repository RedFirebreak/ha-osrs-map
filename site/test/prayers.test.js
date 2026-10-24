import { afterEach, describe, expect, it } from "vitest";
import { prayerIconUrl } from "../src/data/icons";
import { activePrayers, prayerElement, prayerLabel } from "../src/data/prayers";

describe("prayerLabel", () => {
  it("spells prayers as the prayer book does", () => {
    expect(prayerLabel("PROTECT_FROM_MELEE")).toBe("Protect from Melee");
    expect(prayerLabel("BURST_OF_STRENGTH")).toBe("Burst of Strength");
    expect(prayerLabel("PIETY")).toBe("Piety");
    expect(prayerLabel("RP_TRINITAS")).toBe("Trinitas");
    expect(prayerLabel("RP_UMBRA_VOW")).toBe("Umbra's Vow");
  });
});

describe("activePrayers", () => {
  const meta = { active_prayers: ["PROTECT_FROM_MELEE", "PIETY"] };

  it("is what the hub sends while the player is online", () => {
    expect(activePrayers({ online: true, meta })).toEqual(["PROTECT_FROM_MELEE", "PIETY"]);
    expect(activePrayers({ online: true, meta: { active_prayers: [] } })).toEqual([]);
  });

  it("is none once offline, and unknown without the field", () => {
    expect(activePrayers({ online: false, meta })).toEqual([]);
    expect(activePrayers({ online: true, meta: {} })).toBeNull();
    expect(activePrayers({ online: true })).toBeNull();
    expect(activePrayers(undefined)).toBeNull();
  });
});

describe("prayer icons", () => {
  afterEach(() => {
    delete window.siteConfig;
  });

  it("come from the icon CDN under /prayers/, by the lowercased name", () => {
    expect(prayerIconUrl("PROTECT_FROM_MELEE")).toBe("https://icons.scapekeeper.com/prayers/protect_from_melee.png");
    expect(prayerIconUrl("RP_TRINITAS")).toBe("https://icons.scapekeeper.com/prayers/rp_trinitas.png");
    expect(prayerIconUrl("../x")).toBe("");
    window.siteConfig = { iconsBaseUrl: "" };
    expect(prayerIconUrl("PIETY")).toBe("");
  });

  it("show the name when icons are off, and the name beside the icon when asked", () => {
    window.siteConfig = { iconsBaseUrl: "" };
    expect(prayerElement("PIETY").textContent).toBe("Piety");
    delete window.siteConfig;
    const icon = prayerElement("PIETY");
    expect(icon.querySelector("img").alt).toBe("Piety");
    expect(icon.title).toBe("Piety");
    const labelled = prayerElement("PROTECT_FROM_MAGIC", { withLabel: true });
    expect(labelled.querySelector("img").alt).toBe("");
    expect(labelled.textContent).toBe("Protect from Magic");
  });

  it("fall back to the name when the icon fails to load", () => {
    const icon = prayerElement("PIETY");
    icon.querySelector("img").dispatchEvent(new Event("error"));
    expect(icon.querySelector("img")).toBeNull();
    expect(icon.textContent).toBe("Piety");
  });
});
