import { describe, expect, it, vi } from "vite-plus/test";
import { applyIslandSsrHtml, type RenderIslandFn } from "./island-ssr";

describe("applyIslandSsrHtml", () => {
  it("injects adapter HTML without importing a framework SSR package", async () => {
    const html = [
      '<div class="ox-island" data-ox-island="GtvChart" data-ox-props="{&quot;props&quot;:{&quot;title&quot;:&quot;ok&quot;}}">',
      '<script type="application/json">{"props":{"title":"ok"}}</script>',
      "<p>Original slot</p>",
      "</div>",
    ].join("");

    const rendered = await applyIslandSsrHtml(
      html,
      (name, props, filePath, slotHtml) =>
        `<span class="ssr">${name}:${String(props.title)}:${filePath}:${slotHtml}</span>`,
      "/repo/docs/guide.mdx",
    );

    expect(rendered).toContain(
      '<span class="ssr">GtvChart:ok:/repo/docs/guide.mdx:<p>Original slot</p></span>',
    );
    expect(rendered).toContain('data-ox-island="GtvChart"');
    expect(rendered).toContain('data-ox-ssr="true"');
    expect(rendered).toContain("data-ox-content='&lt;p&gt;Original slot&lt;/p&gt;'");
    expect(rendered).toContain('<script type="application/json">');
    expect(rendered).not.toContain("svelte/server");
    expect(rendered).not.toContain("react-dom/server");
    expect(rendered).not.toContain("solid-js/web");
  });

  it.each([
    ["longer", "<b>The inner island has rendered a longer replacement for its original slot.</b>"],
    ["empty", ""],
  ])(
    "passes a complete nested slot to the outer renderer when inner SSR is %s",
    async (_, innerSsr) => {
      const innerSlot = "This is the original slot content of the inner island.";
      const innerAttrs = `data-ox-island="Inner" data-ox-content='${innerSlot}'`;
      const html = `<div data-ox-island="Outer"><div ${innerAttrs}>${innerSlot}</div></div><p>after</p>`;
      const expectedSlot = `<div ${innerAttrs} data-ox-ssr="true">${innerSsr}</div>`;
      const renderIsland = vi.fn<RenderIslandFn>((name, _props, _filePath, slotHtml) =>
        name === "Inner" ? innerSsr : `<section>${slotHtml}</section>`,
      );

      const rendered = await applyIslandSsrHtml(html, renderIsland, "a.md");

      expect.soft(renderIsland).toHaveBeenCalledWith("Outer", {}, "a.md", expectedSlot);
      expect(rendered).toContain(`><section>${expectedSlot}</section></div><p>after</p>`);
    },
  );
});
