import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { resolveConfig } from "vite";
import { compileHonoDocument } from "./document.js";
import { HONO_CLIENT_ID, oxContentHono } from "./vite.js";

const options = {
  highlight: false,
  resources: false,
  docs: false,
  search: false,
  feeds: false,
  siteMaps: false,
};
test("Markdown component compilation preserves YAML, named exports and safe runtime boundaries", async () => {
  const documentPath = join(process.cwd(), "test/component.mdx");
  const result = await compileHonoDocument({
    source:
      '---\ntags:\n  - one\nnested:\n  value: two\n---\n\nimport {Card} from "./Card.tsx";\n\n<Card title="hello" client:visible>**slot**</Card>',
    documentPath,
    root: process.cwd(),
    oxContent: options,
  });
  assert.deepEqual(result.parsed.frontmatter, {
    tags: ["one"],
    nested: { value: "two" },
  });
  assert.match(result.code, /\["Card"\]/);
  assert.match(result.code, /client:visible/);
  assert.match(result.code, /data-ox-module/);
  assert.match(result.code, /data-ox-export/);
  assert.match(result.code, /@ox-content\/vite-plugin-hono\/server/);
  assert.doesNotMatch(result.code, /@ox-content\/vite-plugin(?:\/|['"])|@ox-content\/napi|node:/);
});
test("unregistered islands fail compilation rather than silently dropping components", async () => {
  await assert.rejects(
    compileHonoDocument({
      source: "<Missing />",
      documentPath: "/app/missing.mdx",
      root: "/app",
      oxContent: options,
    }),
    /not registered/,
  );
});
test("automatic entry preserves effective Vite inputs without duplicates", async () => {
  const entries = async (config, options) =>
    (
      await resolveConfig(
        { configFile: false, plugins: oxContentHono(options), ...config },
        "build",
      )
    ).environments.client.build.rolldownOptions.input;
  assert.deepEqual(await entries({}), { "ox-content-hono": HONO_CLIENT_ID });
  assert.deepEqual(
    await entries({ build: { rollupOptions: { input: ["app.ts", "admin.ts", HONO_CLIENT_ID] } } }),
    ["app.ts", "admin.ts", HONO_CLIENT_ID],
  );
  assert.deepEqual(await entries({ build: { rolldownOptions: { input: "app.ts" } } }), [
    "app.ts",
    HONO_CLIENT_ID,
  ]);
  assert.deepEqual(
    await entries({
      environments: { client: { build: { rolldownOptions: { input: "client.ts" } } } },
    }),
    ["client.ts", HONO_CLIENT_ID],
  );
  assert.deepEqual(
    await entries({ build: { rolldownOptions: { input: { "ox-content-hono": "app.ts" } } } }),
    { "ox-content-hono": "app.ts", "ox-content-hono_": HONO_CLIENT_ID },
  );
  const userConfig = { build: { rolldownOptions: { input: "app.ts" } } };
  assert.equal(await entries(userConfig, { routes: false }), "app.ts");
});

test("compiled Markdown renders nested slots and retains JSON prototype keys", async () => {
  const directory = await mkdtemp(join(import.meta.dirname, ".hono-document-"));
  try {
    await writeFile(
      join(directory, "Outer.mjs"),
      'import { jsx } from "hono/jsx"; export default ({ children }) => jsx("article", null, children);',
    );
    await writeFile(
      join(directory, "Inner.mjs"),
      `import { jsx } from "hono/jsx";
      let renders = 0;
      export function Counter() {
        return jsx("b", { "data-render": ++renders, "data-label": "Tom & Jerry's" }, "Nested SSR");
      }`,
    );
    await writeFile(join(directory, "Sibling.mjs"), 'export default () => "Sibling SSR";');
    const { code, parsed } = await compileHonoDocument({
      source: [
        "---",
        "metadata: { __proto__: { named: true } }",
        "---",
        'import Outer from "./Outer.mjs";',
        'import Middle from "./Outer.mjs";',
        'import { Counter as Inner } from "./Inner.mjs";',
        'import Sibling from "./Sibling.mjs";',
        "",
        "<Outer>",
        "",
        "Before",
        "",
        "<Middle>",
        "",
        "<Inner />",
        "",
        "</Middle>",
        "",
        "After",
        "",
        "</Outer>",
        "",
        "<Sibling />",
      ].join("\n"),
      documentPath: join(directory, "nested.mdx"),
      root: directory,
      oxContent: { ...options, srcDir: "." },
      selectFrontmatter: () => JSON.parse('{"__proto__":{"selected":true}}'),
    });
    assert.deepEqual(
      [...code.matchAll(/^import \* as m\d+ from (".+");$/gm)].map(([, id]) =>
        basename(JSON.parse(id)),
      ),
      ["Inner.mjs", "Outer.mjs", "Sibling.mjs"],
    );
    const modulePath = join(directory, "compiled.mjs");
    await writeFile(modulePath, code);
    const { default: Markdown, frontmatter } = await import(pathToFileURL(modulePath).href);
    assert.deepEqual(frontmatter, parsed.frontmatter);
    assert.equal(Object.hasOwn(frontmatter.metadata, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(frontmatter.metadata), Object.prototype);
    const html = (await Markdown()).toString();
    const { document } = parseHTML(html);
    const outer = document.querySelector('[data-ox-island="Outer"]');
    const middle = outer.querySelector('article [data-ox-island="Middle"]');
    const inner = middle.querySelector('article [data-ox-island="Inner"]');
    assert.equal(outer.dataset.oxModule, "/Outer.mjs");
    assert.match(inner.textContent, /^Nested SSR/);
    assert.match(outer.querySelector("article").textContent, /Before[\s\S]*After/);
    const context = JSON.parse(inner.querySelector("[data-ox-hono-context]").textContent);
    assert.equal(Object.hasOwn(context.frontmatter, "__proto__"), true);
    assert.deepEqual(context.frontmatter.__proto__, { selected: true });
    const slot = parseHTML(outer.dataset.oxContent).document;
    const savedMiddle = slot.querySelector('[data-ox-island="Middle"]');
    const savedMiddleSlot = parseHTML(savedMiddle.dataset.oxContent).document;
    for (const copy of [
      inner,
      savedMiddle.querySelector('[data-ox-island="Inner"]'),
      savedMiddleSlot.querySelector('[data-ox-island="Inner"]'),
    ]) {
      assert.equal(copy.dataset.oxModule, "/Inner.mjs");
      assert.equal(copy.dataset.oxExport, "Counter");
      assert.equal(copy.querySelector("b").dataset.label, "Tom & Jerry's");
      assert.equal(copy.querySelector("b").dataset.render, "1");
    }
    assert.match((await Markdown()).toString(), /data-render="2"/);
    assert.doesNotMatch(html, /ox-hono-[a-f0-9]{64}-(?:island|slot|fragment)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
