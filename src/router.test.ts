import assert from "node:assert/strict";
import { test } from "node:test";
import { type DOMWindow, JSDOM } from "jsdom";
import { AppRouter } from "./router";

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(url: string): DOMWindow {
	const dom = new JSDOM("", { url });
	setGlobal("window", dom.window);
	setGlobal("history", dom.window.history);
	setGlobal("location", dom.window.location);
	return dom.window;
}

test("hash router reads, writes, and stops listening after destroy", () => {
	const window = installDom("https://example.test/#/chat/current");
	const router = new AppRouter();
	const navigations: (string | null)[] = [];
	const specialId = "space/slash%?#✓";

	assert.equal(router.getId(), "current");
	assert.equal(router.hrefFor("next"), "#/chat/next");
	assert.equal(router.hrefFor(specialId), "#/chat/space%2Fslash%25%3F%23%E2%9C%93");

	router.setUrl("next");
	assert.equal(window.location.hash, "#/chat/next");

	router.setUrl(specialId);
	assert.equal(window.location.hash, "#/chat/space%2Fslash%25%3F%23%E2%9C%93");
	assert.equal(router.getId(), specialId);

	router.listen((id) => navigations.push(id));
	window.location.hash = "#/chat/from-event";
	window.dispatchEvent(new window.HashChangeEvent("hashchange"));
	assert.deepEqual(navigations, ["from-event"]);

	window.history.pushState(null, "", "#/chat/from-popstate");
	window.dispatchEvent(new window.PopStateEvent("popstate"));
	assert.deepEqual(navigations, ["from-event", "from-popstate"]);

	window.history.pushState(null, "", "#/chat/%E0%A4%A");
	assert.equal(router.getId(), null);

	router.destroy();
	window.location.hash = "#/chat/ignored";
	window.dispatchEvent(new window.HashChangeEvent("hashchange"));
	window.history.pushState(null, "", "#/chat/also-ignored");
	window.dispatchEvent(new window.PopStateEvent("popstate"));
	assert.deepEqual(navigations, ["from-event", "from-popstate"]);
});

test("path router reads, writes, and reports popstate navigation", () => {
	const window = installDom("https://example.test/c/current");
	const router = new AppRouter({ type: "path" });
	const navigations: (string | null)[] = [];
	const specialId = "space/slash%?#✓";

	assert.equal(router.getId(), "current");
	assert.equal(router.hrefFor("next"), "/c/next");
	assert.equal(router.hrefFor(specialId), "/c/space%2Fslash%25%3F%23%E2%9C%93");

	router.setUrl("next");
	assert.equal(window.location.pathname, "/c/next");

	router.setUrl(specialId);
	assert.equal(window.location.pathname, "/c/space%2Fslash%25%3F%23%E2%9C%93");
	assert.equal(router.getId(), specialId);

	router.listen((id) => navigations.push(id));
	window.history.pushState(null, "", "/c/from-popstate");
	window.dispatchEvent(new window.PopStateEvent("popstate"));
	assert.deepEqual(navigations, ["from-popstate"]);

	router.setUrl(null, true);
	assert.equal(window.location.pathname, "/");
});

test("path router derives the blank route from a nested prefix", () => {
	const window = installDom("https://example.test/app/c/current");
	const router = new AppRouter({ type: "path", pathPrefix: "/app/c/" });

	assert.equal(router.getId(), "current");
	assert.equal(router.hrefFor("next/id"), "/app/c/next%2Fid");

	router.setUrl(null, true);

	assert.equal(window.location.pathname, "/app/");
});

test("disabled router leaves the URL alone", () => {
	const window = installDom("https://example.test/#/chat/current");
	const router = new AppRouter({ type: "none" });
	let called = false;

	assert.equal(router.getId(), null);
	assert.equal(router.hrefFor("next"), "#");

	router.listen(() => {
		called = true;
	});
	router.setUrl("next");
	window.dispatchEvent(new window.HashChangeEvent("hashchange"));

	assert.equal(window.location.href, "https://example.test/#/chat/current");
	assert.equal(called, false);
});
