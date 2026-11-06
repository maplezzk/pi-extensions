import assert from "node:assert/strict";
import test from "node:test";
import { piCatalog } from "../src/pi-catalog.ts";
import { standardComponents } from "../src/components/index.ts";
import { renderCatalogDoc } from "../src/catalog-doc.ts";
import { makeSpec } from "./helpers.ts";

test("every catalog component has an implementation and vice versa", () => {
  const catalogNames = [...piCatalog.componentNames].sort();
  const implemented = Object.keys(standardComponents).sort();
  assert.deepEqual(implemented, catalogNames);
});

test("the catalog accepts a well-formed spec and rejects unknown components", () => {
  const good = makeSpec("root", { root: { type: "Text", props: { text: "hello" } } });
  assert.equal(piCatalog.validate(good).success, true);

  const bad = makeSpec("root", { root: { type: "Nope", props: {} } });
  assert.equal(piCatalog.validate(bad).success, false);
});

test("props declared as optional accept missing and null values", () => {
  // Ink's catalog requires every Box prop to be present but nullable; the Pi
  // catalog is a superset so both shapes validate.
  assert.equal(
    piCatalog.validate(makeSpec("root", { root: { type: "Box", props: {} } })).success,
    true,
  );
  assert.equal(
    piCatalog.validate(
      makeSpec("root", { root: { type: "Box", props: { flexDirection: null, padding: 1 } } }),
    ).success,
    true,
  );
});

test("the generated reference lists every component with its props", () => {
  const doc = renderCatalogDoc();
  for (const name of piCatalog.componentNames) {
    assert.ok(doc.includes(`### ${name}`), `missing section for ${name}`);
  }
  assert.ok(doc.includes("IGNORED on Pi"), "ignored props must be marked");
  // The reference must stay verifiable: props come from the same zod schemas.
  assert.ok(doc.includes("flexDirection"));
});

test("the reference stays smaller than the full standalone prompt", () => {
  const doc = renderCatalogDoc();
  const prompt = piCatalog.prompt({ system: "x" });
  assert.ok(doc.length < prompt.length, "reference should be the compact form");
});
